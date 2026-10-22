import { randomUUID } from "node:crypto"
import { baseUrl, restHeaders } from "@/lib/auth"
import { DB, q } from "@/lib/db"
import { EopLetter, findUnsupportedAmounts, parseJsonObject, TriageSummary } from "@/lib/contracts"

/**
 * Direct model calls through Cortex AI Gateway (Anthropic Messages API surface).
 * Every call carries the claim id as the gateway conversation id, so AGENT_TRACE_TABLE('SNOWFLAKE') attributes
 * tokens and latency per claim, and `snow-agent-name` identifies the feature.
 * The model only ever writes prose or picks from enums; numbers come from SQL and are checked after generation.
 */
const FAST_MODEL = process.env.C2C_FAST_MODEL ?? "claude-haiku-5-5"

interface GatewayResult { text: string; inputTokens: number; outputTokens: number; latencyMs: number; status: number
  stopReason: string | null }

async function messages(feature: string, conversationId: string, system: string, user: string, maxTokens = 600):
  Promise<GatewayResult> {
  const t0 = Date.now()
  const res = await fetch(`${baseUrl()}/api/v2/aigateways/snowflake/v1/messages`, {
    method: "POST",
    headers: restHeaders({
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-snowflake-ai-gateway-conversation-id": conversationId,
      "snow-agent-name": `zelis-c2c/${feature}`,
    }),
    // Short structured outputs: disable adaptive thinking, otherwise the model can spend the whole budget thinking
    // and return no text block (observed with claude-haiku-5-5: stop_reason max_tokens, empty content).
    body: JSON.stringify({ model: FAST_MODEL, max_tokens: maxTokens, system, thinking: { type: "disabled" },
      messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(60_000),
  })
  const latencyMs = Date.now() - t0
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(`gateway ${res.status}: ${JSON.stringify(body).slice(0, 300)}`), { status: res.status })
  const text = (body.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
  return { text, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0, latencyMs,
    status: res.status, stopReason: body.stop_reason ?? null }
}

async function logCall(row: {
  callId: string; feature: string; claimId?: string | null; exceptionId?: string | null; batchId?: string | null
  conversationId: string; status: string; httpStatus?: number; latencyMs?: number; inputTokens?: number
  outputTokens?: number; validation?: unknown; output?: string; error?: string
}) {
  await q(`insert into ${DB}.AI.GATEWAY_CALLS (call_id, feature, claim_id, exception_id, batch_id, model, conversation_id,
            status, http_status, latency_ms, input_tokens, output_tokens, validation, output, error)
           select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, parse_json(?), ?, ?`,
    [row.callId, row.feature, row.claimId ?? null, row.exceptionId ?? null, row.batchId ?? null, FAST_MODEL,
     row.conversationId, row.status, row.httpStatus ?? null, row.latencyMs ?? null, row.inputTokens ?? null,
     row.outputTokens ?? null, JSON.stringify(row.validation ?? null), row.output ?? null, row.error ?? null])
}

/** One-line triage for the exception queue. Output must be valid JSON matching TriageSummary; not retried if not. */
export async function triageException(ctx: {
  exceptionId: string; claimId: string; type: string; ruleTitle: string; billed: number; allowed: number | null
  facts: Record<string, unknown>
}): Promise<{ ok: true; summary: TriageSummary; callId: string } | { ok: false; error: string; callId: string }> {
  const callId = randomUUID()
  const system = "You triage healthcare claim exceptions for a payments operations team. Reply with JSON only: " +
    '{"headline": string (<=120 chars, no dollar amounts), "what_to_check": [1-4 short imperative strings]}. ' +
    "Routing and ownership are already decided by rules; do not suggest them. Do not invent facts or amounts."
  const user = JSON.stringify({ exception_type: ctx.type, rule: ctx.ruleTitle, billed: ctx.billed,
    current_allowed: ctx.allowed, facts: ctx.facts })
  try {
    const r = await messages("triage", ctx.claimId, system, user, 300)
    let parsed: TriageSummary | null = null
    let validation: Record<string, unknown> = { kind: "ok" }
    try {
      const p = TriageSummary.safeParse(parseJsonObject(r.text))
      if (p.success) parsed = p.data
      else validation = { kind: "schema_violation", issues: p.error.issues.map((i) => i.message) }
    } catch (e) {
      validation = { kind: "parse_error", message: (e as Error).message, stop_reason: r.stopReason }
    }
    if (parsed && findUnsupportedAmounts(parsed.headline, []).length) {
      validation = { kind: "unsupported_amount" }
      parsed = null
    }
    await logCall({ callId, feature: "triage", claimId: ctx.claimId, exceptionId: ctx.exceptionId,
      conversationId: ctx.claimId, status: parsed ? "OK" : "INVALID", httpStatus: r.status, latencyMs: r.latencyMs,
      inputTokens: r.inputTokens, outputTokens: r.outputTokens, validation, output: r.text })
    return parsed ? { ok: true, summary: parsed, callId } : { ok: false, error: String(validation.kind), callId }
  } catch (e) {
    await logCall({ callId, feature: "triage", claimId: ctx.claimId, exceptionId: ctx.exceptionId,
      conversationId: ctx.claimId, status: "ERROR", httpStatus: (e as any).status, error: (e as Error).message })
    return { ok: false, error: (e as Error).message, callId }
  }
}

/**
 * Provider-facing explanation of payment (EOP) cover letter for one provider in a released batch.
 * Amounts are injected from SQL; the letter is rejected if it states any dollar figure not in the facts.
 */
export async function draftEopLetter(facts: {
  batchId: string; orgId: string; orgName: string; payerName: string; rail: string; settlementDate: string
  total: number; claimCount: number
  claims: Array<{ claim_id: string; billed: number; paid: number; disposition: string }>
  otherClaims: { count: number; paid: number } | null
}): Promise<{ letter: string | null; validated: boolean; validation: unknown; callId: string }> {
  const callId = randomUUID()
  const allowed = [facts.total, ...(facts.otherClaims ? [facts.otherClaims.paid] : []),
    ...facts.claims.flatMap((c) => [c.billed, c.paid, Math.round((c.billed - c.paid) * 100) / 100])]
  const system = "You write short, plain-language explanation-of-payment cover letters to healthcare providers. " +
    "Reply with JSON only: {\"subject\": string, \"body\": string}. The body is the letter text addressed to the provider, " +
    "at most 160 words, no markdown. Use ONLY the facts provided; every dollar amount must appear verbatim in the facts. " +
    "If other_claims is present, summarise those as one sentence using its count and paid amount. " +
    "Never show calculations, never comment on the facts, never write anything other than the letter. " +
    "Do not say a claim was paid in full; paid amounts reflect the contracted allowed amount."
  try {
    const r = await messages("eop_letter", facts.claims[0]?.claim_id ?? facts.batchId, system, JSON.stringify({
      provider: facts.orgName, payer: facts.payerName, payment_method: facts.rail, settlement_date: facts.settlementDate,
      total_paid: facts.total, claim_count: facts.claimCount, listed_claims: facts.claims, other_claims: facts.otherClaims,
    }), 600)
    let letter: EopLetter | null = null
    let validation: Record<string, unknown>
    try {
      const p = EopLetter.safeParse(parseJsonObject(r.text))
      if (!p.success) validation = { kind: "schema_violation", issues: p.error.issues.map((i) => i.message) }
      else {
        const unsupported = findUnsupportedAmounts(`${p.data.subject}\n${p.data.body}`, allowed)
        const meta = /\b(let me|verify|does not match|sum(ming)?|I'll|I will)\b/i.test(p.data.body)
        if (unsupported.length) validation = { kind: "unsupported_amount", amounts: unsupported }
        else if (meta) validation = { kind: "meta_commentary" }
        else { validation = { kind: "ok" }; letter = p.data }
      }
    } catch (e) {
      validation = { kind: "parse_error", message: (e as Error).message, stop_reason: r.stopReason }
    }
    await logCall({ callId, feature: "eop_letter", batchId: facts.batchId, conversationId: facts.batchId,
      status: letter ? "OK" : "INVALID", httpStatus: r.status, latencyMs: r.latencyMs, inputTokens: r.inputTokens,
      outputTokens: r.outputTokens, validation, output: r.text })
    return { letter: letter ? `${letter.subject}\n\n${letter.body}` : null, validated: !!letter, validation, callId }
  } catch (e) {
    await logCall({ callId, feature: "eop_letter", batchId: facts.batchId, conversationId: facts.batchId,
      status: "ERROR", httpStatus: (e as any).status, error: (e as Error).message })
    return { letter: null, validated: false, validation: { kind: "api_error", message: (e as Error).message }, callId }
  }
}
