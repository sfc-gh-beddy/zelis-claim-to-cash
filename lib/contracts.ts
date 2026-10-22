import { z } from "zod"

/** Request bodies for every mutating endpoint. Anything not matching is rejected with 400 before touching SQL. */
export const ResolveRequest = z.object({
  exceptionId: z.string().regex(/^EXC-[A-Z0-9_-]+$/).max(120),
  expectedVersion: z.number().int().positive(),
  decision: z.string().regex(/^[A-Z0-9_]+$/).max(60),
  value: z.number().finite().nonnegative().max(10_000_000).nullable().optional(),
  proposalId: z.string().regex(/^PRP-[a-f0-9-]+$/).nullable().optional(),
  note: z.string().max(2000).optional().default(""),
  idempotencyKey: z.string().uuid(),
})
export type ResolveRequest = z.infer<typeof ResolveRequest>

export const BatchActionRequest = z.object({
  batchId: z.string().regex(/^BAT-[A-Z0-9-]+$/).max(80),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
})

export const CreateBatchesRequest = z.object({ idempotencyKey: z.string().uuid() })

export const SimControlRequest = z.object({
  action: z.enum(["RUN", "PAUSE", "NEXT_DAY", "TICK", "RESET"]),
  minutes: z.number().int().min(5).max(600).optional(),
})

export const AgentRunRequest = z.object({
  exceptionId: z.string().regex(/^EXC-[A-Z0-9_-]+$/).max(120),
})

export const SweepRequest = z.object({
  stage: z.enum(["PRICING", "INTEGRITY", "PAYMENT"]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  concurrency: z.number().int().min(1).max(6).default(3),
})

/** Shape a proposal must have when read back from AI.PROPOSALS (validated before it is shown to a reviewer). */
export const Citation = z.object({
  source: z.string().min(1),
  ref: z.string().min(1),
  quote: z.string().optional().default(""),
})
export const Proposal = z.object({
  decision: z.string().min(1),
  rationale: z.string().min(20),
  citations: z.array(Citation).min(1),
  confidence: z.number().min(0).max(1),
  risk_flags: z.array(z.string()).default([]),
})

/** Gateway output contracts: the model writes prose; every number in it must already exist in the SQL facts. */
export const TriageSummary = z.object({
  headline: z.string().min(5).max(140),
  what_to_check: z.array(z.string().min(3)).min(1).max(4),
})
export type TriageSummary = z.infer<typeof TriageSummary>

export const EopLetter = z.object({
  subject: z.string().min(5).max(160),
  body: z.string().min(40).max(2000),
})
export type EopLetter = z.infer<typeof EopLetter>

export function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("no JSON object in model output")
  return JSON.parse(text.slice(start, end + 1))
}

/** Every money figure in generated prose (with or without "$", two decimals) must match an allowed amount to the cent. */
export function findUnsupportedAmounts(text: string, allowed: number[]): string[] {
  const allowedCents = new Set(allowed.map((a) => Math.round(a * 100)))
  const found = text.match(/\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d{1,3}(?:,\d{3})*\.\d{2}\b|\b\d+\.\d{2}\b/g) ?? []
  return [...new Set(found)].filter((s) => !allowedCents.has(Math.round(Number(s.replace(/[$,\s]/g, "")) * 100)))
}
