import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ q: vi.fn(), create: vi.fn(), send: vi.fn(), stream: vi.fn() }))
vi.mock("@/lib/db", () => ({ DB: "ZELIS_C2C", q: mocks.q }))
vi.mock("@/lib/auth", () => ({ baseUrl: () => "https://example.snowflakecomputing.com", restAuth: () => ({ tokenType: "OAUTH", token: "test-only" }) }))
vi.mock("@snowflake/cortex-agent-sdk", () => ({
  CortexAgentClient: class { conversations = { create: mocks.create } },
  OAuthAuth: class {}, PatAuth: class {},
  AgentResponse: class { usage = { input_tokens: 1, output_tokens: 2 } },
}))
vi.mock("@snowflake/cortex-agent-sdk/api", () => ({ CortexAgentClient: class { runs = { stream: mocks.stream } } }))
import { mapEvent, reattachRun, runAgentForException } from "../../lib/agents"

const args = { exceptionId: "EXC-TEST", claimId: "CLM-TEST", stage: "PRICING", requestedBy: "test", persona: "OPS_LEAD" }
async function collect(source: AsyncIterable<unknown>) {
  const events = []
  for await (const event of source) events.push(event)
  return events
}
beforeEach(() => { vi.resetAllMocks() })

describe("agent launch and recovery", () => {
  it("does not expose private reasoning", () => {
    expect(mapEvent({ event: "response.thinking.delta", text: "private" }, new Map())).toBeNull()
  })
  it("does not launch an agent when another launch owns the exception", async () => {
    mocks.q.mockResolvedValueOnce([{ "number of rows updated": 0 }])
    const events = await collect(runAgentForException(args))
    expect(events).toEqual([expect.objectContaining({ type: "error" })])
    expect(mocks.create).not.toHaveBeenCalled()
  })
  it("returns a reservation if conversation creation fails before submission", async () => {
    mocks.q.mockResolvedValue([{ "number of rows updated": 1 }])
    mocks.create.mockRejectedValueOnce(new Error("creation failed"))
    await expect(collect(runAgentForException(args))).rejects.toThrow("creation failed")
    expect(mocks.q.mock.calls.at(-1)?.[0]).toContain("set status = 'NEW'")
  })
  it("preserves a reservation when submission has an ambiguous outcome", async () => {
    mocks.q.mockResolvedValue([{ "number of rows updated": 1 }])
    mocks.create.mockResolvedValueOnce({ id: "thread", send: mocks.send })
    mocks.send.mockRejectedValueOnce(new Error("connection lost"))
    await expect(collect(runAgentForException(args))).rejects.toThrow("connection lost")
    expect(mocks.q).toHaveBeenCalledTimes(1)
  })
  it("reconnects read-only without replacing the owner's telemetry", async () => {
    mocks.q.mockResolvedValueOnce([{ exception_id: "EXC-TEST", started_at: new Date().toISOString(), status: "COMPLETED" }])
      .mockResolvedValueOnce([{ proposal_id: "PRP-TEST" }])
    mocks.stream.mockImplementation(async function* () { yield { event: "response", status: "completed", metadata: { usage: {} } } })
    const events = await collect(reattachRun("123456"))
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed", proposalId: "PRP-TEST" })
    expect(mocks.q.mock.calls.every(([sql]) => sql.trim().startsWith("select"))).toBe(true)
  })
  it("does not mark an unterminated upstream stream completed", async () => {
    mocks.q.mockResolvedValueOnce([{ exception_id: "EXC-TEST", started_at: new Date().toISOString(), status: "STARTED" }]).mockResolvedValueOnce([])
    mocks.stream.mockImplementation(async function* () { yield { event: "response.status", message: "working" } })
    const events = await collect(reattachRun("123456"))
    expect(events.at(-1)).toMatchObject({ type: "done", status: "incomplete" })
  })
})
