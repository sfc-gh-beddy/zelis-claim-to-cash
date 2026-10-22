import { DB, errorResponse, num, q } from "@/lib/db"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const [sim] = await q(`select s.sim_day, s.sim_minute, s.status, s.minutes_per_tick, ${DB}.OPS.SIM_NOW() sim_now,
        ${DB}.OPS.SIM_DATE() sim_date, (select max(sim_day) from ${DB}.RAW.CLAIMS_SOURCE) max_day,
        (select count(*) from ${DB}.RAW.CLAIMS_SOURCE) total_source_claims
      from ${DB}.OPS.SIM_STATE s`)

    const [k] = await q(`
      with s as (select s.*, c.billed_amt, c.received_at, c.sim_day
                 from ${DB}.CORE.CLAIM_STATE s join ${DB}.RAW.CLAIMS c on c.claim_id = s.claim_id),
      x as (select claim_id, count(*) n from ${DB}.CORE.EXCEPTIONS group by 1)
      select count(*) received,
        count_if(x.n is null) straight_through,
        count_if(x.n is not null) with_exceptions,
        count_if(s.status in ('READY', 'BATCHED', 'RELEASED')) payment_ready,
        count_if(s.status = 'RELEASED') released,
        count_if(s.status = 'DENIED') denied,
        count_if(s.status in ('EXCEPTION', 'RECEIVED')) in_review,
        count_if(s.status in ('HELD', 'OFFER_PENDING')) held,
        count_if(s.ready_sim_ts is not null and to_date(s.ready_sim_ts) = to_date(s.received_at)) ready_same_day,
        sum(s.billed_amt) billed_total,
        sum(iff(s.status in ('READY', 'BATCHED', 'RELEASED', 'DENIED'), s.billed_amt - s.allowed_amt, 0)) pricing_savings,
        sum(iff(s.status = 'RELEASED', s.payable_amt, 0)) released_amt,
        sum(iff(s.status in ('READY', 'BATCHED'), s.payable_amt, 0)) ready_amt,
        sum(iff(s.status in ('EXCEPTION', 'HELD', 'OFFER_PENDING'), coalesce(s.allowed_amt, 0), 0)) pending_amt,
        count_if(s.same_day_eligible) same_day_eligible,
        median(datediff(minute, s.received_at, s.ready_sim_ts)) median_minutes_to_ready,
        approx_percentile(datediff(minute, s.received_at, s.ready_sim_ts), 0.95) p95_minutes_to_ready
      from s left join x on x.claim_id = s.claim_id`)

    const ttr = await q(`
      with s as (select datediff(minute, c.received_at, s.ready_sim_ts) m, (x.claim_id is not null) had_exc,
                   to_date(s.ready_sim_ts) > to_date(c.received_at) next_day
                 from ${DB}.CORE.CLAIM_STATE s join ${DB}.RAW.CLAIMS c on c.claim_id = s.claim_id
                 left join (select distinct claim_id from ${DB}.CORE.EXCEPTIONS) x on x.claim_id = s.claim_id
                 where s.ready_sim_ts is not null)
      select case when next_day then '6 Next day' when m <= 30 then '1 <= 30 min' when m <= 60 then '2 30-60 min'
                  when m <= 120 then '3 1-2 h' when m <= 240 then '4 2-4 h' else '5 > 4 h' end bucket,
        count_if(not had_exc) straight_through, count_if(had_exc) after_review
      from s group by 1 order by 1`)

    const timeline = await q(`
      with r as (select c.sim_day, floor((datediff(minute, dateadd(minute, 480, to_date(c.received_at)::timestamp_ntz),
                         c.received_at)) / 60) hr from ${DB}.RAW.CLAIMS c),
      rd as (select to_date(s.ready_sim_ts) d, floor(datediff(minute, dateadd(minute, 480, to_date(s.ready_sim_ts)::timestamp_ntz),
                      s.ready_sim_ts) / 60) hr, s.payable_amt
             from ${DB}.CORE.CLAIM_STATE s where s.ready_sim_ts is not null),
      days as (select distinct sim_day, dateadd(day, sim_day - 1, (select sim_start from ${DB}.OPS.SIM_STATE)) d
               from ${DB}.RAW.CLAIMS)
      select days.sim_day, h.hr, coalesce(rc.n, 0) received, coalesce(rr.n, 0) ready, coalesce(rr.amt, 0) ready_amt
      from days cross join (select row_number() over (order by seq4()) - 1 hr from table(generator(rowcount => 10))) h
      left join (select sim_day, hr, count(*) n from r group by 1, 2) rc on rc.sim_day = days.sim_day and rc.hr = h.hr
      left join (select d, hr, count(*) n, sum(payable_amt) amt from rd group by 1, 2) rr on rr.d = days.d and rr.hr = h.hr
      order by 1, 2`)

    const aging = await q(`
      select e.stage, e.exception_type, count(*) total,
        count_if(e.status in ('NEW', 'AGENT_WORKING')) open_new, count_if(e.status = 'AGENT_PROPOSED') proposed,
        count_if(e.status = 'RESOLVED') resolved, count_if(e.status = 'ESCALATED') escalated,
        avg(iff(e.status not in ('RESOLVED', 'ESCALATED'), datediff(minute, e.opened_sim_ts, ${DB}.OPS.SIM_NOW()), null)) avg_open_age_min,
        avg(datediff(minute, e.opened_sim_ts, e.resolved_sim_ts)) avg_minutes_to_resolve
      from ${DB}.CORE.EXCEPTIONS e group by 1, 2 order by 1, 2`)

    const [agents] = await q(`
      select count(*) proposals, count_if(status = 'ACCEPTED') accepted, count_if(status = 'OVERRIDDEN') overridden,
        count_if(status = 'PENDING') pending, count_if(status = 'INVALID') invalid
      from ${DB}.AI.PROPOSALS`)

    const runs = await q(`select started_at, finished_at, datediff(millisecond, started_at, finished_at) ms, trigger_source,
        status, claims, attachments, exceptions_opened, ready, sim_ts, error
      from ${DB}.OPS.PIPELINE_RUNS where status <> 'NOOP' order by started_at desc limit 8`)

    return Response.json({
      sim: { ...sim, sim_minute: num(sim?.sim_minute), sim_day: num(sim?.sim_day), max_day: num(sim?.max_day) },
      kpis: Object.fromEntries(Object.entries(k ?? {}).map(([key, v]) => [key, num(v)])),
      timeToReady: ttr.map((r) => ({ bucket: String(r.bucket).slice(2), straight_through: num(r.straight_through),
        after_review: num(r.after_review) })),
      timeline: timeline.map((r) => ({ label: `D${r.sim_day} ${String(8 + Number(r.hr)).padStart(2, "0")}:00`,
        received: num(r.received), ready: num(r.ready), ready_amt: num(r.ready_amt) })),
      aging: aging.map((r) => ({ ...r, total: num(r.total), open_new: num(r.open_new), proposed: num(r.proposed),
        resolved: num(r.resolved), escalated: num(r.escalated), avg_open_age_min: num(r.avg_open_age_min),
        avg_minutes_to_resolve: num(r.avg_minutes_to_resolve) })),
      agents: Object.fromEntries(Object.entries(agents ?? {}).map(([key, v]) => [key, num(v)])),
      pipelineRuns: runs.map((r) => ({ ...r, ms: num(r.ms), claims: num(r.claims), attachments: num(r.attachments),
        exceptions_opened: num(r.exceptions_opened), ready: num(r.ready) })),
    })
  } catch (e) {
    return errorResponse(e, "overview failed")
  }
}
