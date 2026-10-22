import { call, DB, errorResponse, q } from "@/lib/db"
import { BatchActionRequest } from "@/lib/contracts"
import { canApproveBatch } from "@/lib/personas"
import { currentPersona, forbidden } from "@/lib/session"

export const dynamic = "force-dynamic"

const HTTP_FOR_CODE: Record<string, number> = { FORBIDDEN: 403, OVER_LIMIT: 403, SEGREGATION_OF_DUTIES: 403,
  VERSION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, INVALID_STATE: 409, NOT_FOUND: 404 }

/** POST /api/payments/:batchId/:action  where action is approve | release. */
export async function POST(req: Request, ctx: { params: Promise<{ batchId: string; action: string }> }) {
  const { batchId, action } = await ctx.params
  if (action !== "approve" && action !== "release") return Response.json({ error: "unknown action" }, { status: 404 })
  const parsed = BatchActionRequest.safeParse({ ...(await req.json().catch(() => ({}))), batchId })
  if (!parsed.success) return Response.json({ error: "invalid request", issues: parsed.error.issues }, { status: 400 })
  const persona = await currentPersona()
  try {
    if (action === "approve") {
      const [b] = await q<{ total_amt: number; max_claim_amt: number }>(
        `select total_amt, max_claim_amt from ${DB}.CORE.PAYMENT_BATCHES where batch_id = ?`, [batchId])
      if (!b) return Response.json({ error: "not found" }, { status: 404 })
      const check = canApproveBatch(persona, Number(b.total_amt), Number(b.max_claim_amt))
      if (!check.ok) return forbidden(check.reason)
    } else if (!persona.canRelease) {
      return forbidden(`${persona.label} cannot release payments`)
    }
    const proc = action === "approve" ? "APPROVE_BATCH" : "RELEASE_BATCH"
    const r = await call<Record<string, unknown>>(`call ${DB}.CORE.${proc}(?, ?, ?, ?, ?)`,
      [batchId, parsed.data.expectedVersion, persona.person, persona.id, parsed.data.idempotencyKey], true)
    if (r?.ok === false) return Response.json(r, { status: HTTP_FOR_CODE[String(r.code)] ?? 400 })
    return Response.json(r)
  } catch (e) {
    return errorResponse(e, `${action} failed`)
  }
}
