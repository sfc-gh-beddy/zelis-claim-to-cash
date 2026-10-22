"use client"

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { ChartTooltip } from "@/components/chart-utils"
import { ErrorBox, Kpi, Loading, Mono, PageShell, Section, StatusPill, Td, Th, useApi } from "@/components/ui-kit"
import { int, label, pct, shortTs } from "@/lib/format"

export function GovernanceView() {
  const { data, error, isLoading } = useApi<any>(["governance"], "/api/governance", 15000)
  if (isLoading) return <PageShell title="AI governance"><Loading /></PageShell>
  if (error || !data) return <PageShell title="AI governance"><ErrorBox error={error} /></PageShell>
  const runs = data.agentByType.reduce((a: number, r: any) => a + (r.runs ?? 0), 0)
  const proposals = data.agentByType.reduce((a: number, r: any) => a + (r.proposals ?? 0), 0)
  const decided = data.decisions.reduce((a: number, r: any) => a + (r.with_proposal ?? 0), 0)
  const agreed = data.decisions.reduce((a: number, r: any) => a + (r.agreed ?? 0), 0)
  const invalid = data.proposals.find((p: any) => p.status === "INVALID")?.n ?? 0
  const docs = data.pipelineAi.reduce((a: number, r: any) => a + (r.docs ?? 0), 0)
  const evalRows = data.evals.rows as any[]
  return (
    <PageShell title="AI governance"
      subtitle="Where AI was used, what it cost, how often people agreed with it, and how it scores against ground truth.">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi title="Documents through intake AI" value={int(docs)} sub="parse → classify → extract" />
        <Kpi title="Agent runs" value={int(runs)} sub={`${int(proposals)} produced a proposal`} />
        <Kpi title="Reviewer agreement" value={pct(decided ? agreed / decided : null)} sub={`${int(agreed)} of ${int(decided)} decisions with a proposal`} tone="good" />
        <Kpi title="Proposals rejected by contract" value={int(invalid)} sub="schema/allowed-decision check in SQL" tone={invalid ? "warn" : "default"} />
        <Kpi title="Gateway calls" value={int(data.gateway.reduce((a: number, g: any) => a + (g.calls ?? 0), 0))} sub="triage + EOP letters" />
        <Kpi title="Gateway outputs rejected" value={int(data.gateway.reduce((a: number, g: any) => a + (g.invalid ?? 0), 0))}
          sub="failed JSON schema or stated an amount not in SQL facts" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Section title="Eval: agent decisions vs ground truth" hint={evalRows.length
          ? `Latest eval run ${evalRows[0]?.eval_run_id} · ${evalRows[0]?.agent_model} · per-type accuracy with counts (no single headline number)`
          : "No eval run yet: run `node evals/run_evals.mjs` (Phase 5)."}>
          {evalRows.length ? (
            <table className="w-full"><thead><tr><Th>Exception type</Th><Th right>n</Th><Th right>Correct</Th><Th right>Accuracy</Th><Th right>Amount exact</Th><Th right>Source + quote match</Th><Th right>Schema violations</Th><Th right>Avg latency</Th></tr></thead>
              <tbody>{evalRows.map((r) => (
                <tr key={r.exception_type}><Td>{label(r.exception_type)}</Td><Td right>{int(r.n)}</Td><Td right>{int(r.correct)}</Td>
                  <Td right>{pct(r.n ? r.correct / r.n : null, 0)}</Td><Td right>{int(r.amount_correct)} / {int(r.n)}</Td><Td right>{pct(r.n ? r.citation_valid / r.n : null, 0)}</Td>
                  <Td right>{int(r.schema_violations)}</Td><Td right>{r.avg_latency_ms ? `${(r.avg_latency_ms / 1000).toFixed(0)} s` : "—"}</Td></tr>))}</tbody></table>
          ) : <p className="text-xs text-muted-foreground">{data.evals.error ?? ""}</p>}
          <p className="mt-2 text-xs text-muted-foreground">Citation checks verify source IDs and verbatim quotes only. Whether the evidence supports the decision still requires human review. Failures remain in the denominator.</p>
        </Section>
        <Section title="Reviewer decisions vs agent proposals" hint="From CORE.EXCEPTIONS.resolution">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.decisions.map((d: any) => ({ ...d, name: label(d.exception_type) }))} margin={{ left: 0, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} angle={-15} textAnchor="end" height={45} />
                <YAxis tick={{ fontSize: 10 }} width={30} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} /><Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="agreed" name="Accepted proposal" stackId="a" fill="#29b5e8" />
                <Bar dataKey="overridden" name="Overrode proposal" stackId="a" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Section title="Cortex Agents by exception type" hint="AI.AGENT_RUNS (SDK-reported usage; agent turns are not in gateway traces)">
          <table className="w-full"><thead><tr><Th>Type</Th><Th>Agent</Th><Th right>Runs</Th><Th right>Proposals</Th><Th right>p50</Th><Th right>p95</Th><Th right>Avg tokens in/out</Th><Th right>Cache hit</Th></tr></thead>
            <tbody>{data.agentByType.map((r: any) => (
              <tr key={r.exception_type + r.agent_name}><Td>{label(r.exception_type)}</Td><Td>{label(r.agent_name)}</Td><Td right>{int(r.runs)}</Td><Td right>{int(r.proposals)}</Td>
                <Td right>{r.p50_ms ? `${(r.p50_ms / 1000).toFixed(0)} s` : "—"}</Td><Td right>{r.p95_ms ? `${(r.p95_ms / 1000).toFixed(0)} s` : "—"}</Td>
                <Td right>{int(r.avg_input_tokens)} / {int(r.avg_output_tokens)}</Td><Td right>{pct(r.cache_hit, 0)}</Td></tr>))}</tbody></table>
        </Section>
        <Section title="AI usage by claim path" hint="Straight-through claims use intake AI only when they carry documents; agents only touch exceptions">
          <table className="w-full"><thead><tr><Th>Path</Th><Th right>Claims</Th><Th right>Doc pages</Th><Th right>Agent runs</Th><Th right>Agent tokens</Th><Th right>Gateway calls</Th><Th right>Gateway tokens</Th></tr></thead>
            <tbody>{data.perClaim.map((p: any) => (
              <tr key={p.path}><Td>{label(p.path)}</Td><Td right>{int(p.claims)}</Td><Td right>{int(p.doc_pages)}</Td><Td right>{int(p.agent_runs)}</Td>
                <Td right>{int(p.agent_tokens)}</Td><Td right>{int(p.gateway_calls)}</Td><Td right>{int(p.gateway_tokens)}</Td></tr>))}</tbody></table>
          <div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Credits (ACCOUNT_USAGE, lagged hours) · last 7 days</div>
          {data.credits.error ? <p className="text-xs text-muted-foreground">{data.credits.error}</p> : (
            <table className="w-full"><tbody>{data.credits.rows.map((c: any) => (
              <tr key={c.source}><Td>{label(c.source)}</Td><Td right>{c.credits === null ? "not landed yet" : Number(c.credits).toFixed(3)}</Td><Td>{shortTs(c.latest)}</Td></tr>))}</tbody></table>)}
        </Section>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Section title="Intake AI quality by document type" hint="AI.DOC_EXTRACTS: money fields need extraction score ≥ 0.85 to price">
          <table className="w-full"><thead><tr><Th>Doc type</Th><Th right>Docs</Th><Th right>Pages</Th><Th right>OK</Th><Th right>Low confidence</Th><Th right>Failed</Th><Th right>OCR retried</Th></tr></thead>
            <tbody>{data.pipelineAi.map((r: any) => (
              <tr key={r.doc_type ?? "unclassified"}><Td>{label(r.doc_type ?? "unclassified")}</Td><Td right>{int(r.docs)}</Td><Td right>{int(r.pages)}</Td><Td right>{int(r.ok)}</Td>
                <Td right>{int(r.low_conf)}</Td><Td right>{int(r.failed)}</Td><Td right>{int(r.retried)}</Td></tr>))}</tbody></table>
        </Section>
        <Section title="Live AI Gateway traces" hint="AGENT_TRACE_TABLE('SNOWFLAKE'): conversation id = claim id (lands ~1 minute after the call)">
          {data.traces.error ? <p className="text-xs text-muted-foreground">{data.traces.error}</p> : (
            <div className="max-h-64 overflow-auto">
              <table className="w-full"><thead><tr><Th>Time</Th><Th>Feature</Th><Th>Claim / batch</Th><Th>Model</Th><Th right>Tokens</Th><Th right>ms</Th><Th right>HTTP</Th></tr></thead>
                <tbody>{data.traces.rows.map((t: any, i: number) => (
                  <tr key={i}><Td>{shortTs(t.timestamp)}</Td><Td>{String(t.feature).replace("zelis-c2c/", "")}</Td><Td><Mono>{t.conversation_id}</Mono></Td>
                    <Td>{t.model}</Td><Td right>{int(t.input_tokens)}/{int(t.output_tokens)}</Td><Td right>{int(t.duration_ms)}</Td><Td right>{t.http_status}</Td></tr>))}
                  {!data.traces.rows.length && <tr><Td className="text-muted-foreground">No gateway calls in the last 2 days.</Td></tr>}</tbody></table>
            </div>)}
        </Section>
      </div>

      <Section className="mt-4" title="Audit log" hint="OPS.AUDIT_LOG: every proposal, decision, denial, approval and release">
        <div className="max-h-80 overflow-auto">
          <table className="w-full"><thead><tr><Th>When</Th><Th>Sim time</Th><Th>Actor</Th><Th>Action</Th><Th>Entity</Th><Th>Detail</Th></tr></thead>
            <tbody>{data.audit.map((a: any, i: number) => (
              <tr key={i}><Td>{shortTs(a.event_ts)}</Td><Td>{shortTs(a.sim_ts)}</Td><Td>{a.actor}<div className="text-[10px] text-muted-foreground">{label(a.persona)}</div></Td>
                <Td><StatusPill value={a.action.includes("DENIED") ? "INVALID" : a.action.includes("RELEASED") ? "RELEASED" : undefined} /> {label(a.action)}</Td>
                <Td><Mono>{a.entity_id ?? "—"}</Mono></Td>
                <Td><code className="line-clamp-2 font-mono text-[10px] text-muted-foreground">{JSON.stringify(a.detail)}</code></Td></tr>))}</tbody></table>
        </div>
      </Section>
    </PageShell>
  )
}
