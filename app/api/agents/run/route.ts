import { DB, q } from "@/lib/db"
import { AgentRunRequest } from "@/lib/contracts"
import { runAgentForException, sseResponse } from "@/lib/agents"
import { currentPersona } from "@/lib/session"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/** Start a Cortex Agent run for one exception and stream its events (SSE). */
export async function POST(req: Request) {
  const parsed = AgentRunRequest.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 })
  const persona = await currentPersona()
  const [exc] = await q<{ claim_id: string; stage: string; status: string }>(
    `select claim_id, stage, status from ${DB}.CORE.EXCEPTIONS where exception_id = ?`, [parsed.data.exceptionId])
  if (!exc) return Response.json({ error: "not found" }, { status: 404 })
  if (exc.status === "RESOLVED" || exc.status === "ESCALATED") {
    return Response.json({ error: "exception is closed" }, { status: 409 })
  }
  const activeEval = await q(`select exception_id from ${DB}.OPS.EVAL_ACTIVE
    where exception_id = ? and expires_at > current_timestamp()`, [parsed.data.exceptionId])
  if (activeEval.length) return Response.json({ error: "exception reserved for evaluation" }, { status: 409 })
  return sseResponse(runAgentForException({ exceptionId: parsed.data.exceptionId, claimId: exc.claim_id,
    stage: exc.stage, requestedBy: persona.person, persona: persona.id }))
}
