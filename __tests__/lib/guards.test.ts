import { describe, expect, it } from "vitest"
import { canApproveBatch, canResolve, parsePersona, PERSONAS } from "@/lib/personas"
import { findUnsupportedAmounts, parseJsonObject, Proposal, ResolveRequest, SweepRequest } from "@/lib/contracts"

describe("personas", () => {
  it("falls back to the Ops Lead for unknown cookies", () => {
    expect(parsePersona(undefined).id).toBe("OPS_LEAD")
    expect(parsePersona("ADMIN").id).toBe("OPS_LEAD")
    expect(parsePersona("PRICING_ANALYST").id).toBe("PRICING_ANALYST")
  })

  it("restricts exception resolution by stage", () => {
    expect(canResolve(PERSONAS.PRICING_ANALYST, "PRICING", "MODIFIER_REVIEW")).toBe(true)
    expect(canResolve(PERSONAS.PRICING_ANALYST, "INTEGRITY", "UNBUNDLING")).toBe(false)
    expect(canResolve(PERSONAS.INTEGRITY_REVIEWER, "INTEGRITY", "DUPLICATE_SUSPECT")).toBe(true)
    expect(canResolve(PERSONAS.PAYMENT_APPROVER, "PRICING", "MODIFIER_REVIEW")).toBe(false)
  })

  it("only lets the Ops Lead clear a bank-change hold", () => {
    expect(canResolve(PERSONAS.OPS_LEAD, "PAYMENT", "BANK_CHANGE_HOLD")).toBe(true)
    expect(canResolve(PERSONAS.PAYMENT_APPROVER, "PAYMENT", "BANK_CHANGE_HOLD")).toBe(false)
  })

  it("enforces the approval matrix", () => {
    expect(canApproveBatch(PERSONAS.PAYMENT_APPROVER, 249_999.99, 10_000)).toEqual({ ok: true })
    expect(canApproveBatch(PERSONAS.PAYMENT_APPROVER, 250_000.01, 10_000).ok).toBe(false)
    expect(canApproveBatch(PERSONAS.PAYMENT_APPROVER, 100_000, 50_000.01).ok).toBe(false)
    expect(canApproveBatch(PERSONAS.PRICING_ANALYST, 1, 1).ok).toBe(false)
    expect(canApproveBatch(PERSONAS.OPS_LEAD, 9_000_000, 2_000_000)).toEqual({ ok: true })
  })
})

describe("request contracts", () => {
  const ok = { exceptionId: "EXC-CLM2610000097-PI_EM_LEVEL5_PREPAY-L1", expectedVersion: 3, decision: "DOWNCODE_TO_99213",
    idempotencyKey: "0b6a3f5e-3c1d-4a4b-9a2e-1f2b3c4d5e6f" }

  it("accepts a well-formed resolve request", () => {
    expect(ResolveRequest.safeParse(ok).success).toBe(true)
  })

  it("rejects SQL-ish identifiers and bad idempotency keys", () => {
    expect(ResolveRequest.safeParse({ ...ok, exceptionId: "EXC-1'; drop table x;--" }).success).toBe(false)
    expect(ResolveRequest.safeParse({ ...ok, decision: "deny claim" }).success).toBe(false)
    expect(ResolveRequest.safeParse({ ...ok, idempotencyKey: "abc" }).success).toBe(false)
    expect(ResolveRequest.safeParse({ ...ok, value: -5 }).success).toBe(false)
  })

  it("bounds the sweep size and concurrency", () => {
    expect(SweepRequest.parse({}).limit).toBe(10)
    expect(SweepRequest.safeParse({ limit: 500 }).success).toBe(false)
    expect(SweepRequest.safeParse({ concurrency: 20 }).success).toBe(false)
  })

  it("requires citations and a bounded confidence on proposals", () => {
    const base = { decision: "DENY_DUPLICATE", rationale: "Frequency code 1 and identical lines to an earlier claim.",
      citations: [{ source: "policy", ref: "POL_DUP.pdf#02", quote: "denied as a duplicate" }], confidence: 0.9 }
    expect(Proposal.safeParse(base).success).toBe(true)
    expect(Proposal.safeParse({ ...base, citations: [] }).success).toBe(false)
    expect(Proposal.safeParse({ ...base, confidence: 1.4 }).success).toBe(false)
  })
})

describe("generated-text guards", () => {
  it("flags amounts that are not in the SQL facts, with or without $", () => {
    const allowed = [45579.84, 1598.81, 504.88]
    expect(findUnsupportedAmounts("Total $45,579.84; claim paid $504.88.", allowed)).toEqual([])
    expect(findUnsupportedAmounts("Total $45,579.84 and $12.00 interest.", allowed)).toEqual(["$12.00"])
    expect(findUnsupportedAmounts("Summing 197.40 + 1,457.13 = 5,304.64", allowed)).toEqual(["197.40", "1,457.13", "5,304.64"])
  })

  it("extracts a JSON object surrounded by prose", () => {
    expect(parseJsonObject('Here you go: {"headline": "x"} thanks')).toEqual({ headline: "x" })
    expect(() => parseJsonObject("no json")).toThrow()
  })
})
