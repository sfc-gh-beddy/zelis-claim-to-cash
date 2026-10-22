"use client"

import { useState } from "react"
import Link from "next/link"
import { useQueryClient } from "@tanstack/react-query"
import { Bot, Loader2 } from "lucide-react"
import { Btn, ErrorBox, Loading, PageShell, Section, StagePill, StatusPill, Td, Th, postJson, useApi } from "@/components/ui-kit"
import { usePersona } from "@/components/persona-switcher"
import { int, label, minutes, money, pct } from "@/lib/format"
import { cn } from "@/lib/utils"

type Row = {
  exception_id: string; claim_id: string; stage: string; exception_type: string; rule_id: string; rule_version: number
  status: string; rule_title: string; age_minutes: number; billed_amt: number; allowed_amt: number | null; org_name: string
  payer_name: string; proposed_decision: string | null; confidence: number | null; proposed_allowed_amt: number | null
  proposal_status: string | null; resolved_decision: string | null; agreed_with_agent: boolean | null
}
type Sweep = { sweep_id: string; stage: string; status: string; planned: number; started: number; completed: number
  failed: number; proposals: number; avg_latency_ms: number | null }

const STAGES = ["ALL", "PRICING", "INTEGRITY", "PAYMENT"] as const
const STATUSES = ["OPEN", "NEW", "AGENT_PROPOSED", "RESOLVED", "ESCALATED", "ALL"] as const

export function ExceptionQueue() {
  const qc = useQueryClient()
  const { data: persona } = usePersona()
  const [stage, setStage] = useState<(typeof STAGES)[number]>("ALL")
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("OPEN")
  const qs = new URLSearchParams({ ...(stage !== "ALL" ? { stage } : {}), status })
  const { data, error, isLoading } = useApi<{ rows: Row[]; counts: Array<{ stage: string; status: string; n: number }> }>(
    ["exceptions", stage, status], `/api/exceptions?${qs}`, 6000)
  const sweeps = useApi<Sweep[]>(["sweeps"], "/api/agents/sweep", 4000)
  const [sweepMsg, setSweepMsg] = useState<string | null>(null)
  const running = sweeps.data?.find((s) => s.status === "RUNNING")

  async function startSweep() {
    setSweepMsg(null)
    const r = await postJson("/api/agents/sweep", { stage: stage === "ALL" ? undefined : stage, limit: 12, concurrency: 4 })
    setSweepMsg(r.ok ? `Sweep started: agents are working ${r.data.planned} exceptions in the background.` : r.data?.error)
    await qc.invalidateQueries({ queryKey: ["sweeps"] })
  }

  const openBy = (st: string) => (data?.counts ?? []).filter((c) => (st === "ALL" || c.stage === st)
    && ["NEW", "AGENT_WORKING", "AGENT_PROPOSED"].includes(c.status)).reduce((a, c) => a + c.n, 0)

  return (
    <PageShell title="Exception queue"
      subtitle="Only claims that hit a rule land here. Agents propose; a person with the right role decides."
      actions={
        <>
          {persona?.current.id === "OPS_LEAD" ? (
            <Btn onClick={startSweep} disabled={!!running}
              title="Start Cortex Agent runs for the oldest new exceptions (runs in the background; proposals still need approval)">
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
              {running ? `Sweep running ${running.started}/${running.planned}` : "Sweep queue with agents"}
            </Btn>
          ) : <span className="text-xs text-muted-foreground">Ops Lead can sweep the queue with agents</span>}
        </>
      }>
      {sweepMsg && <div className="mb-3 rounded-md border border-border bg-card px-3 py-2 text-xs">{sweepMsg}</div>}
      {sweeps.data?.[0] && (
        <div className="mb-3 flex flex-wrap gap-4 rounded-md border border-border bg-card px-3 py-2 text-xs">
          <span className="font-medium">Last sweep</span><StatusPill value={sweeps.data[0].status} />
          <span>{int(sweeps.data[0].completed)}/{int(sweeps.data[0].planned)} runs complete</span>
          <span>{int(sweeps.data[0].proposals)} proposals</span>
          <span>{int(sweeps.data[0].failed)} failed</span>
          <span>avg {sweeps.data[0].avg_latency_ms ? `${(sweeps.data[0].avg_latency_ms / 1000).toFixed(0)} s` : "—"} per exception</span>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {STAGES.map((s) => (
          <button key={s} onClick={() => setStage(s)}
            className={cn("rounded-full border px-3 py-1 text-xs", stage === s ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/10 font-medium" : "border-border")}>
            {label(s)} <span className="text-muted-foreground">({openBy(s)})</span>
          </button>
        ))}
        <span className="mx-2 h-4 w-px bg-border" />
        <select aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value as any)}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs">
          {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
        </select>
      </div>
      <Section title={`${data?.rows.length ?? 0} exceptions`}>
        {isLoading ? <Loading /> : error ? <ErrorBox error={error} /> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr><Th>Exception</Th><Th>Stage</Th><Th>Type / rule</Th><Th>Provider · payer</Th><Th right>Billed</Th>
                <Th right>Current allowed</Th><Th>Agent proposal</Th><Th right>Age</Th><Th>Status</Th></tr></thead>
              <tbody>
                {data!.rows.map((r) => (
                  <tr key={r.exception_id} className="hover:bg-muted/40">
                    <Td><Link className="font-mono text-[11px] text-[var(--brand-primary)] hover:underline" href={`/exceptions/${encodeURIComponent(r.exception_id)}`}>{r.claim_id}</Link></Td>
                    <Td><StagePill stage={r.stage} /></Td>
                    <Td><div className="font-medium">{label(r.exception_type)}</div><div className="text-[11px] text-muted-foreground">{r.rule_title} · v{r.rule_version}</div></Td>
                    <Td><div>{r.org_name}</div><div className="text-[11px] text-muted-foreground">{r.payer_name}</div></Td>
                    <Td right>{money(r.billed_amt)}</Td>
                    <Td right>{r.allowed_amt === null ? <span className="text-muted-foreground">needs input</span> : money(r.allowed_amt)}</Td>
                    <Td>{r.proposed_decision ? (
                      <div><div className="font-medium">{label(r.proposed_decision)}</div>
                        <div className="text-[11px] text-muted-foreground">{money(r.proposed_allowed_amt)} · conf {pct(r.confidence, 0)}</div></div>
                    ) : r.resolved_decision ? <span className="text-muted-foreground">{label(r.resolved_decision)}</span> : <span className="text-muted-foreground">—</span>}</Td>
                    <Td right>{minutes(r.age_minutes)}</Td>
                    <Td><StatusPill value={r.status} /></Td>
                  </tr>
                ))}
                {!data!.rows.length && <tr><Td className="text-muted-foreground">Nothing here.</Td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </PageShell>
  )
}
