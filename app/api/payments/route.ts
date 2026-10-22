import { call, DB, errorResponse, num, q } from "@/lib/db"
import { CreateBatchesRequest } from "@/lib/contracts"
import { currentPersona, forbidden } from "@/lib/session"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const readiness = await q(`
      select s.status, coalesce(s.pay_method, '-') pay_method, count(*) n, sum(coalesce(s.payable_amt, s.allowed_amt, 0)) amt,
        count_if(s.same_day_eligible) same_day_eligible
      from ${DB}.CORE.CLAIM_STATE s group by 1, 2 order by 1, 2`)
    const blockers = await q(`
      select e.exception_type blocker, e.stage, count(distinct e.claim_id) claims, sum(coalesce(s.allowed_amt, c.billed_amt)) amt
      from ${DB}.CORE.EXCEPTIONS e join ${DB}.CORE.CLAIM_STATE s on s.claim_id = e.claim_id
      join ${DB}.RAW.CLAIMS c on c.claim_id = e.claim_id
      where e.status not in ('RESOLVED') and s.status in ('EXCEPTION', 'HELD')
      group by 1, 2
      union all
      select 'NOT_EPAY_ENROLLED (check, next business day)', 'PAYMENT', count(*), sum(s.payable_amt)
      from ${DB}.CORE.CLAIM_STATE s where s.status in ('READY', 'BATCHED') and s.pay_method = 'CHECK'
      order by 3 desc`)
    const batches = await q(`
      select b.*, p.payer_name,
        (select count(distinct e.claim_id) from ${DB}.CORE.BATCH_ITEMS i join ${DB}.CORE.EXCEPTIONS e on e.claim_id = i.claim_id
          where i.batch_id = b.batch_id) claims_with_resolved_exceptions,
        (select array_agg(distinct e.resolved_by) from ${DB}.CORE.BATCH_ITEMS i join ${DB}.CORE.EXCEPTIONS e on e.claim_id = i.claim_id
          where i.batch_id = b.batch_id and e.resolved_by is not null) resolvers
      from ${DB}.CORE.PAYMENT_BATCHES b join ${DB}.CORE.PAYERS p on p.payer_id = b.payer_id
      order by iff(b.status = 'RELEASED', 1, 0), b.created_sim_ts desc, b.total_amt desc limit 100`)
    const [sim] = await q(`select sim_minute, ${DB}.OPS.SIM_NOW() sim_now from ${DB}.OPS.SIM_STATE`)
    return Response.json({
      readiness: readiness.map((r) => ({ ...r, n: num(r.n), amt: num(r.amt), same_day_eligible: num(r.same_day_eligible) })),
      blockers: blockers.map((r) => ({ ...r, claims: num(r.claims), amt: num(r.amt) })),
      batches: batches.map((b) => ({ ...b, total_amt: num(b.total_amt), max_claim_amt: num(b.max_claim_amt),
        claim_count: num(b.claim_count), version: num(b.version),
        claims_with_resolved_exceptions: num(b.claims_with_resolved_exceptions),
        resolvers: typeof b.resolvers === "string" ? JSON.parse(b.resolvers) : b.resolvers ?? [] })),
      clock: { sim_minute: num(sim?.sim_minute), sim_now: sim?.sim_now, ach_cutoff_minute: 405,
        ach_cutoff_passed: (num(sim?.sim_minute) ?? 0) > 405 },
    })
  } catch (e) {
    return errorResponse(e, "payments failed")
  }
}

export async function POST(req: Request) {
  const persona = await currentPersona()
  if (!persona.canCreateBatches) return forbidden(`${persona.label} cannot create payment batches`)
  const parsed = CreateBatchesRequest.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 })
  try {
    const r = await call<Record<string, unknown>>(`call ${DB}.CORE.CREATE_BATCHES(?, ?, ?)`,
      [persona.person, persona.id, parsed.data.idempotencyKey], true)
    return Response.json(r, { status: r?.ok === false ? 403 : 200 })
  } catch (e) {
    return errorResponse(e, "create batches failed")
  }
}
