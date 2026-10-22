import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../lib/snowflake", () => ({
  querySnowflake: vi.fn(),
  querySnowflakeLongRunning: vi.fn(),
  getServiceToken: vi.fn(() => ""),
  getSnowflakeBaseUrl: vi.fn(() => "https://example.snowflakecomputing.com"),
}))
const cookieStore = new Map<string, string>()
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (k: string) => (cookieStore.has(k) ? { value: cookieStore.get(k) } : undefined),
    set: (k: string, v: string) => cookieStore.set(k, v) }),
  headers: async () => new Map(),
}))

import { querySnowflake, querySnowflakeLongRunning } from "../../lib/snowflake"
import { POST as resolve } from "../../app/api/exceptions/[id]/resolve/route"
import { POST as batchAction } from "../../app/api/payments/[batchId]/[action]/route"
import { POST as sim } from "../../app/api/sim/route"

const EXC = "EXC-CLM2610000079-PI_UNBUNDLING-L2"
const KEY = "0b6a3f5e-3c1d-4a4b-9a2e-1f2b3c4d5e6f"
const req = (body: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(body) })
const params = <T,>(p: T) => ({ params: Promise.resolve(p) })

beforeEach(() => {
  vi.clearAllMocks()
  cookieStore.clear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("POST /api/exceptions/:id/resolve", () => {
  it("refuses a persona outside the exception's stage without calling the procedure", async () => {
    cookieStore.set("c2c_persona", "PRICING_ANALYST")
    vi.mocked(querySnowflake).mockResolvedValueOnce([{ STAGE: "INTEGRITY", EXCEPTION_TYPE: "UNBUNDLING" }])
    const res = await resolve(req({ expectedVersion: 1, decision: "DENY_COMPONENT_LINE", idempotencyKey: KEY }), params({ id: EXC }))
    expect(res.status).toBe(403)
    expect(querySnowflakeLongRunning).not.toHaveBeenCalled()
  })

  it("passes binds (never string-concatenated input) and maps VERSION_CONFLICT to 409", async () => {
    cookieStore.set("c2c_persona", "INTEGRITY_REVIEWER")
    vi.mocked(querySnowflake).mockResolvedValueOnce([{ STAGE: "INTEGRITY", EXCEPTION_TYPE: "UNBUNDLING" }])
    vi.mocked(querySnowflakeLongRunning).mockResolvedValueOnce([{ R: JSON.stringify({ ok: false, code: "VERSION_CONFLICT" }) }])
    const res = await resolve(req({ expectedVersion: 1, decision: "DENY_COMPONENT_LINE", idempotencyKey: KEY }), params({ id: EXC }))
    expect(res.status).toBe(409)
    const [sql, opts] = vi.mocked(querySnowflakeLongRunning).mock.calls[0]
    expect(sql).toContain("CORE.RESOLVE_EXCEPTION(?, ?, ?, ?, ?, ?, ?, ?, ?)")
    expect(sql).not.toContain(EXC)
    expect((opts as any).binds).toEqual([EXC, 1, "DENY_COMPONENT_LINE", null, null, "Marcus Lee", "INTEGRITY_REVIEWER", KEY, ""])
  })

  it("rejects malformed bodies with 400 before touching Snowflake", async () => {
    const res = await resolve(req({ expectedVersion: "1" }), params({ id: EXC }))
    expect(res.status).toBe(400)
    expect(querySnowflake).not.toHaveBeenCalled()
  })
})

describe("POST /api/payments/:batchId/:action", () => {
  const BATCH = "BAT-20261028-1800-PAY03-ACH"

  it("blocks an approver over the $250K batch limit before calling APPROVE_BATCH", async () => {
    cookieStore.set("c2c_persona", "PAYMENT_APPROVER")
    vi.mocked(querySnowflake).mockResolvedValueOnce([{ TOTAL_AMT: 312_000, MAX_CLAIM_AMT: 9_000 }])
    const res = await batchAction(req({ expectedVersion: 1, idempotencyKey: KEY }), params({ batchId: BATCH, action: "approve" }))
    expect(res.status).toBe(403)
    expect(querySnowflakeLongRunning).not.toHaveBeenCalled()
  })

  it("maps segregation-of-duties refusals from the procedure to 403", async () => {
    cookieStore.set("c2c_persona", "OPS_LEAD")
    vi.mocked(querySnowflake).mockResolvedValueOnce([{ TOTAL_AMT: 10_000, MAX_CLAIM_AMT: 900 }])
    vi.mocked(querySnowflakeLongRunning).mockResolvedValueOnce([{ R: { ok: false, code: "SEGREGATION_OF_DUTIES" } }])
    const res = await batchAction(req({ expectedVersion: 1, idempotencyKey: KEY }), params({ batchId: BATCH, action: "approve" }))
    expect(res.status).toBe(403)
  })

  it("does not let a Pricing Analyst release payments", async () => {
    cookieStore.set("c2c_persona", "PRICING_ANALYST")
    const res = await batchAction(req({ expectedVersion: 2, idempotencyKey: KEY }), params({ batchId: BATCH, action: "release" }))
    expect(res.status).toBe(403)
  })
})

describe("POST /api/sim", () => {
  it("only the Ops Lead controls the simulation", async () => {
    cookieStore.set("c2c_persona", "PAYMENT_APPROVER")
    const res = await sim(req({ action: "RUN" }))
    expect(res.status).toBe(403)
    expect(querySnowflake).not.toHaveBeenCalled()
  })

  it("blocks browser reset without mutating Snowflake", async () => {
    cookieStore.set("c2c_persona", "OPS_LEAD")
    const res = await sim(req({ action: "RESET" }))
    expect(res.status).toBe(409)
    expect(querySnowflakeLongRunning).not.toHaveBeenCalled()
  })

  it("blocks time advancement during active evaluation or agent work", async () => {
    cookieStore.set("c2c_persona", "OPS_LEAD")
    vi.mocked(querySnowflake).mockResolvedValueOnce([{ EXCEPTION_ID: EXC }])
    const res = await sim(req({ action: "TICK", minutes: 30 }))
    expect(res.status).toBe(409)
    expect(querySnowflakeLongRunning).not.toHaveBeenCalled()
  })

  it("rejects unknown actions", async () => {
    cookieStore.set("c2c_persona", "OPS_LEAD")
    const res = await sim(req({ action: "DROP_DATABASE" }))
    expect(res.status).toBe(400)
  })
})
