import { DB, errorResponse, json, num, q } from "@/lib/db"

export const dynamic = "force-dynamic"

const STATUSES = new Set(["NEW", "AGENT_WORKING", "AGENT_PROPOSED", "RESOLVED", "ESCALATED"])
const STAGES = new Set(["PRICING", "INTEGRITY", "PAYMENT"])

export async function GET(req: Request) {
  const url = new URL(req.url)
  const stage = url.searchParams.get("stage")
  const status = url.searchParams.get("status") ?? "OPEN"
  const where: string[] = []
  const binds: unknown[] = []
  if (stage && STAGES.has(stage)) { where.push("e.stage = ?"); binds.push(stage) }
  if (status === "OPEN") where.push("e.status in ('NEW', 'AGENT_WORKING', 'AGENT_PROPOSED')")
  else if (STATUSES.has(status)) { where.push("e.status = ?"); binds.push(status) }
  try {
    const rows = await q(`
      select e.exception_id, e.claim_id, e.stage, e.exception_type, e.rule_id, e.rule_version, e.line_no, e.status,
        e.owner_persona, e.opened_sim_ts, e.resolved_sim_ts, e.version, e.details:rule_title::string rule_title,
        datediff(minute, e.opened_sim_ts, coalesce(e.resolved_sim_ts, ${DB}.OPS.SIM_NOW())) age_minutes,
        c.billed_amt, s.allowed_amt, s.status claim_status, o.org_name, p.payer_name,
        pr.decision proposed_decision, pr.confidence, pr.proposed_allowed_amt, pr.status proposal_status,
        e.resolution:decision::string resolved_decision, e.resolution:agreed_with_agent::boolean agreed_with_agent
      from ${DB}.CORE.EXCEPTIONS e
      join ${DB}.RAW.CLAIMS c on c.claim_id = e.claim_id
      join ${DB}.CORE.CLAIM_STATE s on s.claim_id = e.claim_id
      join ${DB}.CORE.PROVIDER_ORGS o on o.org_id = c.org_id
      join ${DB}.CORE.PAYERS p on p.payer_id = c.payer_id
      left join ${DB}.AI.PROPOSALS pr on pr.proposal_id = e.latest_proposal_id
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by iff(e.status in ('RESOLVED', 'ESCALATED'), 1, 0), e.opened_sim_ts, e.exception_id
      limit 500`, binds)
    const counts = await q(`select stage, status, count(*) n from ${DB}.CORE.EXCEPTIONS group by 1, 2`)
    return Response.json({
      rows: rows.map((r) => ({ ...r, billed_amt: num(r.billed_amt), allowed_amt: num(r.allowed_amt),
        confidence: num(r.confidence), proposed_allowed_amt: num(r.proposed_allowed_amt), age_minutes: num(r.age_minutes),
        version: num(r.version), line_no: num(r.line_no), rule_version: num(r.rule_version),
        agreed_with_agent: json(r.agreed_with_agent) })),
      counts: counts.map((r) => ({ ...r, n: num(r.n) })),
    })
  } catch (e) {
    return errorResponse(e, "exception list failed")
  }
}
