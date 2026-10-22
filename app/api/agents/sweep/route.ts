import { randomUUID } from "node:crypto"
import { DB, errorResponse, num, q } from "@/lib/db"
import { SweepRequest } from "@/lib/contracts"
import { runToCompletion } from "@/lib/agents"
import { currentPersona, forbidden } from "@/lib/session"

export const dynamic = "force-dynamic"

/**
 * Queue sweep: agents work the oldest NEW exceptions (bounded concurrency) while nobody watches.
 * Runs in the background of the service process; progress is persisted in OPS.SWEEPS + AI.AGENT_RUNS, so the UI
 * polls state from Snowflake rather than holding a connection open. Agents only propose; humans still resolve.
 */
export async function POST(req: Request) {
  const persona = await currentPersona()
  if (persona.id !== "OPS_LEAD") return forbidden("Only the Ops Lead can start a queue sweep")
  const parsed = SweepRequest.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "invalid request", issues: parsed.error.issues }, { status: 400 })
  const { stage, limit, concurrency } = parsed.data
  try {
    const running = await q(`select sweep_id from ${DB}.OPS.SWEEPS where status = 'RUNNING'
      and started_at > dateadd(minute, -30, current_timestamp())`)
    if (running.length) return Response.json({ error: "a sweep is already running", sweepId: running[0].sweep_id }, { status: 409 })
    const items = await q<{ exception_id: string; claim_id: string; stage: string }>(
      `select exception_id, claim_id, stage from ${DB}.CORE.EXCEPTIONS e where status = 'NEW'
       and not exists (select 1 from ${DB}.OPS.EVAL_ACTIVE a where a.exception_id = e.exception_id and a.expires_at > current_timestamp())
       ${stage ? "and stage = ?" : ""} order by opened_sim_ts, exception_id limit ${Number(limit)}`, stage ? [stage] : [])
    const sweepId = `SWP-${randomUUID()}`
    await q(`insert into ${DB}.OPS.SWEEPS (sweep_id, stage, requested_by, persona, status, planned, started_at, concurrency)
             select ?, ?, ?, ?, 'RUNNING', ?, current_timestamp(), ?`,
      [sweepId, stage ?? "ALL", persona.person, persona.id, items.length, concurrency])

    void (async () => {
      const queue = [...items]
      const worker = async () => {
        while (queue.length) {
          const it = queue.shift()!
          try {
            await runToCompletion({ exceptionId: it.exception_id, claimId: it.claim_id, stage: it.stage,
              requestedBy: persona.person, persona: persona.id, sweepId })
          } catch (e) {
            console.error(new Date().toISOString(), "sweep item failed", it.exception_id, e)
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
      await q(`update ${DB}.OPS.SWEEPS set status = 'DONE', finished_at = current_timestamp() where sweep_id = ?`, [sweepId])
    })().catch((e) => console.error(new Date().toISOString(), "sweep failed", e))

    return Response.json({ sweepId, planned: items.length })
  } catch (e) {
    return errorResponse(e, "sweep failed to start")
  }
}

export async function GET() {
  try {
    const sweeps = await q(`select s.sweep_id, s.stage, s.status, s.planned, s.started_at, s.finished_at, s.requested_by,
        count(r.run_id) started, count_if(r.status = 'COMPLETED') completed, count_if(r.status = 'FAILED') failed,
        count_if(r.proposal_id is not null) proposals, avg(r.latency_ms) avg_latency_ms
      from ${DB}.OPS.SWEEPS s left join ${DB}.AI.AGENT_RUNS r on r.sweep_id = s.sweep_id
      group by 1, 2, 3, 4, 5, 6, 7 order by s.started_at desc limit 5`)
    return Response.json(sweeps.map((s) => ({ ...s, planned: num(s.planned), started: num(s.started),
      completed: num(s.completed), failed: num(s.failed), proposals: num(s.proposals), avg_latency_ms: num(s.avg_latency_ms) })))
  } catch (e) {
    return errorResponse(e, "sweep status failed")
  }
}
