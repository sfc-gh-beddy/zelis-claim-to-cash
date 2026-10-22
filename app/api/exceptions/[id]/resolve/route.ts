import { call, DB, errorResponse } from "@/lib/db"
import { ResolveRequest } from "@/lib/contracts"
import { canResolve } from "@/lib/personas"
import { currentPersona, forbidden } from "@/lib/session"
import { q } from "@/lib/db"

export const dynamic = "force-dynamic"

const HTTP_FOR_CODE: Record<string, number> = { FORBIDDEN: 403, VERSION_CONFLICT: 409, ALREADY_CLOSED: 409,
  NOT_FOUND: 404, INVALID_DECISION: 400, VALUE_REQUIRED: 400, EVAL_IN_PROGRESS: 409,
  INVALID_PROPOSAL: 409, IDEMPOTENCY_CONFLICT: 409, ORIGINAL_PAYMENT_COMMITTED: 409 }

/** Human resolution. Persona is checked here and again inside CORE.RESOLVE_EXCEPTION. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const parsed = ResolveRequest.safeParse({ ...(await req.json().catch(() => ({}))), exceptionId: id })
  if (!parsed.success) return Response.json({ error: "invalid request", issues: parsed.error.issues }, { status: 400 })
  const b = parsed.data
  const persona = await currentPersona()
  try {
    const [exc] = await q<{ stage: string; exception_type: string }>(
      `select stage, exception_type from ${DB}.CORE.EXCEPTIONS where exception_id = ?`, [id])
    if (!exc) return Response.json({ error: "not found" }, { status: 404 })
    if (!canResolve(persona, exc.stage, exc.exception_type)) {
      return forbidden(`${persona.label} cannot resolve ${exc.stage.toLowerCase()} exceptions of type ${exc.exception_type}`)
    }
    const result = await call<Record<string, unknown>>(
      `call ${DB}.CORE.RESOLVE_EXCEPTION(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, b.expectedVersion, b.decision, b.value ?? null, b.proposalId ?? null, persona.person, persona.id,
       b.idempotencyKey, b.note], true)
    if (result?.ok === false) {
      return Response.json(result, { status: HTTP_FOR_CODE[String(result.code)] ?? 400 })
    }
    return Response.json(result)
  } catch (e) {
    return errorResponse(e, "resolve failed")
  }
}
