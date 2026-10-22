import { DB, errorResponse, json, num, q } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const rules = await q(`
      select r.rule_id, r.version, r.status, r.stage, r.exception_type, r.title, r.predicate_sql, r.owner_persona,
        r.created_by, r.activated_at,
        count(e.exception_id) flags, count_if(e.status = 'RESOLVED') resolved, count_if(e.status = 'ESCALATED') escalated,
        count_if(e.status not in ('RESOLVED', 'ESCALATED')) open,
        count_if(e.resolution:decision::string in ('DENY_DUPLICATE', 'DENY_COMPONENT_LINE', 'DOWNCODE_TO_99213',
          'HOLD_FRAUD_REVIEW')) adverse,
        count_if(e.resolution:decision::string in ('ALLOW_AS_BILLED', 'UPHOLD_LEVEL', 'REPLACE_ORIGINAL',
          'RELEASE_AFTER_VERIFICATION')) cleared
      from ${DB}.CORE.RULES r left join ${DB}.CORE.EXCEPTIONS e on e.rule_id = r.rule_id and e.rule_version = r.version
      group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 order by r.stage, r.rule_id, r.version`)
    const flags = await q(`
      select e.exception_id, e.claim_id, e.exception_type, e.rule_id, e.rule_version, e.status, e.opened_sim_ts,
        c.billed_amt, s.allowed_amt, o.org_name, pr.decision proposed, pr.confidence, pr.rationale,
        e.resolution:decision::string resolved_decision, e.resolved_by,
        (select max(cs.allowed_amt) from ${DB}.CORE.CLAIM_STATE cs where cs.claim_id = e.claim_id) current_allowed
      from ${DB}.CORE.EXCEPTIONS e join ${DB}.RAW.CLAIMS c on c.claim_id = e.claim_id
      join ${DB}.CORE.CLAIM_STATE s on s.claim_id = e.claim_id join ${DB}.CORE.PROVIDER_ORGS o on o.org_id = c.org_id
      left join ${DB}.AI.PROPOSALS pr on pr.proposal_id = e.latest_proposal_id
      where e.stage = 'INTEGRITY' order by e.opened_sim_ts desc limit 300`)
    const [savings] = await q(`
      select sum(iff(e.status = 'RESOLVED', a.before_amt - a.after_amt, 0)) avoided
      from ${DB}.CORE.EXCEPTIONS e
      join (select p.exception_id, max(p.current_allowed_amt) before_amt, min(p.proposed_allowed_amt) after_amt
            from ${DB}.AI.PROPOSALS p where p.status = 'ACCEPTED' group by 1) a on a.exception_id = e.exception_id
      where e.stage = 'INTEGRITY'`)
    const providers = await q(`
      select o.org_name, o.specialty, count(distinct c.claim_id) claims,
        round(count_if(l.code = '99215') / nullif(count_if(l.code in ('99212', '99213', '99214', '99215')), 0), 3) level5_share,
        o.em_outlier prepay_review
      from ${DB}.RAW.CLAIMS c join ${DB}.RAW.CLAIM_LINES l on l.claim_id = c.claim_id
      join ${DB}.CORE.PROVIDER_ORGS o on o.org_id = c.org_id
      group by 1, 2, 5 having count_if(l.code in ('99212', '99213', '99214', '99215')) > 0
      order by level5_share desc nulls last limit 12`)
    return Response.json({
      rules: rules.map((r) => ({ ...r, version: num(r.version), flags: num(r.flags), resolved: num(r.resolved),
        escalated: num(r.escalated), open: num(r.open), adverse: num(r.adverse), cleared: num(r.cleared) })),
      flags: flags.map((f) => ({ ...f, billed_amt: num(f.billed_amt), allowed_amt: num(f.allowed_amt),
        confidence: num(f.confidence), current_allowed: num(f.current_allowed), rule_version: num(f.rule_version) })),
      avoided: num(savings?.avoided) ?? 0,
      providers: providers.map((p) => ({ ...p, claims: num(p.claims), level5_share: num(p.level5_share),
        prepay_review: json(p.prepay_review) })),
    })
  } catch (e) {
    return errorResponse(e, "integrity failed")
  }
}
