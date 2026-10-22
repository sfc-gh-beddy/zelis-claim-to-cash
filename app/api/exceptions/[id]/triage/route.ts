import { DB, errorResponse, json, num, q } from "@/lib/db"
import { triageException } from "@/lib/gateway"

export const dynamic = "force-dynamic"

/** Fast AI Gateway triage summary for one exception (Claude Haiku via the gateway Messages API). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!/^EXC-[A-Z0-9_-]+$/.test(id)) return Response.json({ error: "bad id" }, { status: 400 })
  try {
    const [r] = await q(`select e.exception_id, e.claim_id, e.exception_type, e.details:rule_title::string rule_title,
        c.billed_amt, s.allowed_amt, s.pricing_snapshot, o.network_kind, o.specialty, c.frequency_code,
        (select array_agg(object_construct('doc_type', d.doc_type, 'fields', d.fields)) from ${DB}.AI.DOC_EXTRACTS d
          where d.claim_id = e.claim_id) docs
      from ${DB}.CORE.EXCEPTIONS e join ${DB}.RAW.CLAIMS c on c.claim_id = e.claim_id
      join ${DB}.CORE.CLAIM_STATE s on s.claim_id = e.claim_id join ${DB}.CORE.PROVIDER_ORGS o on o.org_id = c.org_id
      where e.exception_id = ?`, [id])
    if (!r) return Response.json({ error: "not found" }, { status: 404 })
    const snap = json<any>(r.pricing_snapshot)
    const result = await triageException({
      exceptionId: id, claimId: String(r.claim_id), type: String(r.exception_type), ruleTitle: String(r.rule_title),
      billed: num(r.billed_amt) ?? 0, allowed: num(r.allowed_amt),
      facts: { network: r.network_kind, specialty: r.specialty, frequency_code: r.frequency_code,
        lines: (snap?.lines ?? []).map((l: any) => ({ code: l.code, mods: l.mods, units: l.units, method: l.method })),
        documents: json(r.docs) },
    })
    return Response.json(result, { status: result.ok ? 200 : 502 })
  } catch (e) {
    return errorResponse(e, "triage failed")
  }
}
