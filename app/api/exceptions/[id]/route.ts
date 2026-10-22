import { DB, errorResponse, json, num, q } from "@/lib/db"
import { Proposal } from "@/lib/contracts"

export const dynamic = "force-dynamic"

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!/^EXC-[A-Z0-9_-]+$/.test(id)) return Response.json({ error: "bad id" }, { status: 400 })
  try {
    const [e] = await q(`select e.*, e.details:rule_title::string rule_title, r.predicate_sql, r.title rule_name
      from ${DB}.CORE.EXCEPTIONS e left join ${DB}.CORE.RULES r on r.rule_id = e.rule_id and r.version = e.rule_version
      where e.exception_id = ?`, [id])
    if (!e) return Response.json({ error: "not found" }, { status: 404 })
    const claimId = e.claim_id as string
    const [claim] = await q(`select c.*, s.status claim_status, s.allowed_amt, s.payable_amt, s.pricing_status,
        s.pricing_snapshot, s.pay_method, s.same_day_eligible, s.version claim_version, o.org_name, o.tin, o.specialty,
        o.network_kind, o.epay_enrolled, p.payer_name, pr.provider_name, pr.npi
      from ${DB}.RAW.CLAIMS c join ${DB}.CORE.CLAIM_STATE s on s.claim_id = c.claim_id
      join ${DB}.CORE.PROVIDER_ORGS o on o.org_id = c.org_id join ${DB}.CORE.PAYERS p on p.payer_id = c.payer_id
      join ${DB}.CORE.PROVIDERS pr on pr.provider_id = c.provider_id where c.claim_id = ?`, [claimId])
    const docs = await q(`select d.attachment_id, d.file_name, d.doc_type, d.status, d.page_count, d.fields, d.scores,
        d.min_score, d.parsed_text, d.attempts, a.scanned,
        get_presigned_url(@${DB}.RAW.INTAKE, d.file_name, 900) url
      from ${DB}.AI.DOC_EXTRACTS d left join ${DB}.RAW.ATTACHMENTS_SOURCE a on a.attachment_id = d.attachment_id
      where d.claim_id = ? order by d.attachment_id`, [claimId])
    const decisions = await q(`select decision, label, outcome, needs_value, description from ${DB}.CORE.DECISIONS
      where exception_type = ? order by decision`, [e.exception_type])
    const proposals = await q(`select proposal_id, agent_name, agent_run_id, decision, adjustments, dry_run,
        proposed_allowed_amt, current_allowed_amt, rationale, citations, confidence, risk_flags, schema_valid,
        validation_errors, status, created_at
      from ${DB}.AI.PROPOSALS where exception_id = ? and source <> 'EVAL' order by created_at desc limit 10`, [id])
    const runs = await q(`select run_id, agent_name, status, started_at, latency_ms, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, tool_calls, tool_errors, answer, proposal_id, error
      from ${DB}.AI.AGENT_RUNS where exception_id = ? order by started_at desc limit 10`, [id])
    const audit = await q(`select event_ts, sim_ts, actor, persona, action, detail from ${DB}.OPS.AUDIT_LOG
      where entity_id = ? or detail:claim_id::string = ? order by event_ts desc limit 50`, [id, claimId])
    const triage = await q(`select output, validation, status, created_at, latency_ms from ${DB}.AI.GATEWAY_CALLS
      where exception_id = ? and feature = 'triage' order by created_at desc limit 1`, [id])
    const related = await q(`select exception_id, exception_type, status from ${DB}.CORE.EXCEPTIONS
      where claim_id = ? and exception_id <> ?`, [claimId, id])

    return Response.json({
      exception: { ...e, details: json(e.details), resolution: json(e.resolution), version: num(e.version),
        line_no: num(e.line_no) },
      claim: claim && { ...claim, pricing_snapshot: json(claim.pricing_snapshot), billed_amt: num(claim.billed_amt),
        allowed_amt: num(claim.allowed_amt), payable_amt: num(claim.payable_amt) },
      documents: docs.map((d) => ({ ...d, fields: json(d.fields), scores: json(d.scores), min_score: num(d.min_score) })),
      decisions,
      proposals: proposals.map((p) => {
        const parsed = Proposal.safeParse({ decision: p.decision, rationale: p.rationale, citations: json(p.citations),
          confidence: num(p.confidence), risk_flags: json(p.risk_flags) ?? [] })
        return { ...p, adjustments: json(p.adjustments), dry_run: json(p.dry_run), citations: json(p.citations),
          risk_flags: json(p.risk_flags), validation_errors: json(p.validation_errors), confidence: num(p.confidence),
          proposed_allowed_amt: num(p.proposed_allowed_amt), current_allowed_amt: num(p.current_allowed_amt),
          contract_valid: parsed.success, contract_issues: parsed.success ? [] : parsed.error.issues.map((i) => i.message) }
      }),
      runs: runs.map((r) => ({ ...r, tool_calls: json(r.tool_calls), latency_ms: num(r.latency_ms),
        input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens), cache_read_tokens: num(r.cache_read_tokens),
        cache_write_tokens: num(r.cache_write_tokens) })),
      audit: audit.map((a) => ({ ...a, detail: json(a.detail) })),
      triage: triage[0] ? { ...triage[0], validation: json(triage[0].validation) } : null,
      related,
    })
  } catch (err) {
    return errorResponse(err, "exception detail failed")
  }
}
