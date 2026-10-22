import { DB, errorResponse, json, num, q } from "@/lib/db"

export const dynamic = "force-dynamic"

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<{ data: T; error?: string }> {
  try { return { data: await fn() } } catch (e) { return { data: fallback, error: (e as Error).message } }
}

// Trace table and ACCOUNT_USAGE are slow and change slowly (traces ~1 min, usage hours): cache them per process.
const slowCache = new Map<string, { at: number; value: unknown }>()
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = slowCache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T
  const value = await fn()
  slowCache.set(key, { at: Date.now(), value })
  return value
}

export async function GET() {
  try {
    const agentByTypeP = q(`
      select e.exception_type, r.agent_name, count(*) runs, count_if(r.status = 'COMPLETED') completed,
        count_if(r.proposal_id is not null) proposals, median(r.latency_ms) p50_ms, approx_percentile(r.latency_ms, 0.95) p95_ms,
        avg(r.input_tokens + coalesce(r.cache_read_tokens, 0) + coalesce(r.cache_write_tokens, 0)) avg_input_tokens,
        avg(r.output_tokens) avg_output_tokens,
        sum(coalesce(r.cache_read_tokens, 0)) / nullif(sum(r.input_tokens + coalesce(r.cache_read_tokens, 0) + coalesce(r.cache_write_tokens, 0)), 0) cache_hit,
        avg(r.tool_errors) avg_tool_errors
      from ${DB}.AI.AGENT_RUNS r join ${DB}.CORE.EXCEPTIONS e on e.exception_id = r.exception_id
      group by 1, 2 order by 1`)
    const decisionsP = q(`
      select e.exception_type, count(*) resolved, count_if(e.resolution:proposal_id is not null) with_proposal,
        count_if(e.resolution:agreed_with_agent::boolean) agreed, count_if(e.resolution:agreed_with_agent::boolean = false) overridden
      from ${DB}.CORE.EXCEPTIONS e where e.status in ('RESOLVED', 'ESCALATED') group by 1 order by 1`)
    const proposalsP = q(`select status, count(*) n, count_if(not schema_valid) schema_invalid from ${DB}.AI.PROPOSALS where source <> 'EVAL' group by 1`)
    const gatewayP = q(`select feature, model, count(*) calls, count_if(status = 'OK') ok, count_if(status = 'INVALID') invalid,
        count_if(status = 'ERROR') errors, median(latency_ms) p50_ms, sum(input_tokens) input_tokens, sum(output_tokens) output_tokens
      from ${DB}.AI.GATEWAY_CALLS group by 1, 2 order by 1`)
    const recentRunsP = q(`select r.run_id, r.exception_id, r.claim_id, r.agent_name, r.status, r.started_at, r.latency_ms,
        r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.tool_calls, r.proposal_id, p.decision
      from ${DB}.AI.AGENT_RUNS r left join ${DB}.AI.PROPOSALS p on p.proposal_id = r.proposal_id
      order by r.started_at desc limit 25`)
    const pipelineAiP = q(`select doc_type, count(*) docs, count_if(status = 'OK') ok, count_if(status = 'LOW_CONFIDENCE') low_conf,
        count_if(status like '%FAILED%') failed, count_if(coalesce(attempts, 1) > 1) retried, avg(min_score) avg_money_score,
        sum(page_count) pages
      from ${DB}.AI.DOC_EXTRACTS group by 1 order by 2 desc`)
    const auditP = q(`select event_ts, sim_ts, actor, persona, action, entity_type, entity_id, detail
      from ${DB}.OPS.AUDIT_LOG order by event_ts desc limit 60`)
    const evalsP = safe(() => q(`select r.eval_run_id, r.started_at, r.label, r.agent_model, x.exception_type, x.n, x.correct,
        x.schema_violations, x.citation_valid, x.amount_correct, x.avg_latency_ms
      from ${DB}.OPS.EVAL_RUNS r join (
        select eval_run_id, exception_type, count(*) n, count_if(decision_correct) correct,
          count_if(failure_kind = 'schema_violation') schema_violations, count_if(citations_valid) citation_valid,
          count_if(amount_correct) amount_correct, avg(latency_ms) avg_latency_ms
        from ${DB}.OPS.EVAL_RESULTS group by 1, 2) x on x.eval_run_id = r.eval_run_id
      where r.eval_run_id = (select eval_run_id from ${DB}.OPS.EVAL_RUNS where status = 'DONE' order by started_at desc limit 1)
      order by x.exception_type`), [])

    // Live gateway traces (lands ~1 minute after a call). Requires MONITOR on the gateway.
    const tracesP = cached("traces", 60_000, () => safe(() => q(`
      select timestamp, record_attributes:"gen_ai.conversation.id"::string conversation_id,
        record_attributes:"gen_ai.request.model"::string model,
        record_attributes:"http.request.header.snow-agent-name"::string feature,
        try_to_number(record_attributes:"gen_ai.usage.input_tokens"::string) input_tokens,
        try_to_number(record_attributes:"gen_ai.usage.output_tokens"::string) output_tokens,
        datediff(millisecond, start_timestamp, timestamp) duration_ms,
        try_to_number(record_attributes:"http.status_code"::string) http_status, trace:"trace_id"::string trace_id
      from table(AGENT_TRACE_TABLE('SNOWFLAKE'))
      where timestamp > dateadd(day, -2, current_timestamp())
        and record_attributes:"http.request.header.snow-agent-name"::string like 'zelis-c2c/%'
      order by timestamp desc limit 40`), []))

    // Credits (lagged, typically hours): reconciliation, not the live view.
    const creditsP = cached("credits", 300_000, () => safe(() => q(`
      select 'cortex_agents' source, sum(token_credits) credits, max(start_time) latest
      from SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AGENT_USAGE_HISTORY
      where agent_database_name = '${DB}' and start_time > dateadd(day, -7, current_timestamp())
      union all
      select 'ai_functions', sum(credits), max(start_time) from SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AI_FUNCTIONS_USAGE_HISTORY
      where start_time > dateadd(day, -7, current_timestamp()) and array_contains('ZELIS_C2C_ROLE'::variant, role_names)
      union all
      select 'ai_gateway (all callers on account)', sum(credits), max(start_time) from SNOWFLAKE.ACCOUNT_USAGE.AI_GATEWAY_USAGE_HISTORY
      where start_time > dateadd(day, -7, current_timestamp())
      union all
      select 'warehouse', sum(credits_used), max(end_time) from SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
      where warehouse_name = 'ZELIS_C2C_WH' and start_time > dateadd(day, -7, current_timestamp())`), []))

    const perClaimP = q(`
      with a as (select claim_id, sum(input_tokens + coalesce(cache_read_tokens, 0) + coalesce(cache_write_tokens, 0)) agent_in,
                   sum(output_tokens) agent_out, count(*) agent_runs from ${DB}.AI.AGENT_RUNS group by 1),
           g as (select claim_id, sum(input_tokens) gw_in, sum(output_tokens) gw_out, count(*) gw_calls
                 from ${DB}.AI.GATEWAY_CALLS where claim_id is not null group by 1),
           d as (select claim_id, count(*) docs, sum(page_count) pages from ${DB}.AI.DOC_EXTRACTS group by 1)
      select coalesce(x.stp, 'unknown') path, count(*) claims, sum(coalesce(d.pages, 0)) doc_pages,
        sum(coalesce(a.agent_runs, 0)) agent_runs, sum(coalesce(a.agent_in, 0) + coalesce(a.agent_out, 0)) agent_tokens,
        sum(coalesce(g.gw_calls, 0)) gateway_calls, sum(coalesce(g.gw_in, 0) + coalesce(g.gw_out, 0)) gateway_tokens
      from ${DB}.CORE.CLAIM_STATE s
      left join (select claim_id, 'exception' stp from ${DB}.CORE.EXCEPTIONS group by 1) x on x.claim_id = s.claim_id
      left join a on a.claim_id = s.claim_id left join g on g.claim_id = s.claim_id left join d on d.claim_id = s.claim_id
      group by 1`)

    const [agentByType, decisions, proposals, gateway, recentRuns, pipelineAi, audit, evals, traces, credits, perClaim] =
      await Promise.all([agentByTypeP, decisionsP, proposalsP, gatewayP, recentRunsP, pipelineAiP, auditP, evalsP, tracesP,
        creditsP, perClaimP])
    const n = (rows: any[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
      [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])))
    return Response.json({
      agentByType: n(agentByType), decisions: n(decisions), proposals: n(proposals), gateway: n(gateway),
      recentRuns: n(recentRuns).map((r) => ({ ...r, tool_calls: json(r.tool_calls) })),
      pipelineAi: n(pipelineAi), audit: audit.map((a) => ({ ...a, detail: json(a.detail) })),
      evals: { rows: n(evals.data), error: evals.error },
      traces: { rows: n(traces.data), error: traces.error },
      credits: { rows: n(credits.data).map((c) => ({ ...c, credits: num(c.credits) })), error: credits.error },
      perClaim: n(perClaim).map((p) => ({ ...p, path: p.path === "unknown" ? "straight-through" : p.path })),
    })
  } catch (e) {
    return errorResponse(e, "governance failed")
  }
}
