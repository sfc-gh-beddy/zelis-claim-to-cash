"use client"

import { useState } from "react"
import Link from "next/link"
import { useQueryClient } from "@tanstack/react-query"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { FastForward, Pause, Play, SkipForward } from "lucide-react"
import { ChartTooltip } from "@/components/chart-utils"
import { Btn, ErrorBox, Kpi, Loading, PageShell, Section, StagePill, StatusPill, Td, Th, postJson, useApi } from "@/components/ui-kit"
import { usePersona } from "@/components/persona-switcher"
import { int, label, minutes, money, moneyShort, pct, shortTs, simClock } from "@/lib/format"

type Overview = {
  sim: { sim_day: number; sim_minute: number; status: string; sim_now: string; sim_date: string; max_day: number }
  kpis: Record<string, number | null>
  timeToReady: Array<{ bucket: string; straight_through: number; after_review: number }>
  timeline: Array<{ label: string; received: number; ready: number; ready_amt: number }>
  aging: Array<{ stage: string; exception_type: string; total: number; open_new: number; proposed: number; resolved: number
    escalated: number; avg_open_age_min: number | null; avg_minutes_to_resolve: number | null }>
  agents: Record<string, number | null>
  pipelineRuns: Array<{ started_at: string; ms: number; trigger_source: string; status: string; claims: number
    attachments: number; exceptions_opened: number; ready: number; sim_ts: string; error: string | null }>
}

function Funnel({ k }: { k: Overview["kpis"] }) {
  const steps = [
    { name: "Received", v: k.received ?? 0 },
    { name: "Priced straight-through", v: k.straight_through ?? 0 },
    { name: "Payment-ready", v: k.payment_ready ?? 0 },
    { name: "Released", v: k.released ?? 0 },
  ]
  const max = Math.max(1, steps[0].v)
  return (
    <div className="space-y-2">
      {steps.map((s) => (
        <div key={s.name}>
          <div className="mb-0.5 flex justify-between text-xs"><span>{s.name}</span><span className="tabular-nums">{int(s.v)}</span></div>
          <div className="h-2.5 rounded bg-muted"><div className="h-2.5 rounded bg-[var(--brand-primary)]" style={{ width: `${(s.v / max) * 100}%` }} /></div>
        </div>
      ))}
      <div className="flex gap-4 pt-1 text-xs text-muted-foreground">
        <span>In review: <b className="text-foreground">{int(k.in_review)}</b></span>
        <span>Held: <b className="text-foreground">{int(k.held)}</b></span>
        <span>Denied: <b className="text-foreground">{int(k.denied)}</b></span>
      </div>
    </div>
  )
}

export function CommandCenter() {
  const qc = useQueryClient()
  const { data: persona } = usePersona()
  const { data, error, isLoading } = useApi<Overview>(["overview"], "/api/overview", 5000)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const canControl = persona?.current.canControlSimulation

  async function sim(action: string, minutesArg?: number) {
    setBusy(action); setMsg(null)
    const r = await postJson("/api/sim", { action, minutes: minutesArg })
    if (!r.ok) setMsg(r.data?.error ?? "failed")
    else if (action === "TICK") {
      const p = r.data?.pipeline
      setMsg(p ? `Advanced ${minutesArg} min: ${p.claims ?? 0} claims priced, ${p.exceptions_opened ?? 0} exceptions, ${p.ready ?? 0} ready`
        : `Clock: ${r.data?.status ?? "day end"}`)
    }
    setBusy(null)
    await qc.invalidateQueries()
  }

  if (isLoading) return <PageShell title="Command Center"><Loading /></PageShell>
  if (error || !data) return <PageShell title="Command Center"><ErrorBox error={error} /></PageShell>
  const { sim: s, kpis: k } = data
  const stpRate = k.received ? (k.straight_through ?? 0) / k.received : null
  const sameDay = k.received ? (k.ready_same_day ?? 0) / k.received : null

  return (
    <PageShell
      title="Command Center"
      subtitle={<>Simulated business day {s.sim_day} of {s.max_day} · <b className="tabular-nums">{simClock(s.sim_minute)}</b>{" "}
        ({String(s.sim_date).slice(0, 10)}) · <StatusPill value={s.status} /></>}
      actions={canControl ? (
        <>
          {s.status === "RUNNING"
            ? <Btn variant="secondary" disabled={!!busy} onClick={() => sim("PAUSE")}><Pause className="h-3.5 w-3.5" />Pause</Btn>
            : <Btn disabled={!!busy || (s.status === "DAY_END" && s.sim_day >= s.max_day)} onClick={() => sim("RUN")}
                title="Starts the 1-minute task: 30 simulated minutes per real minute"><Play className="h-3.5 w-3.5" />
                {s.status === "DAY_END" ? "Start next day" : "Run"}</Btn>}
          <Btn variant="secondary" disabled={!!busy || s.status === "DAY_END"} onClick={() => sim("TICK", 60)}>
            <FastForward className="h-3.5 w-3.5" />{busy === "TICK" ? "Advancing…" : "+60 min"}</Btn>
          <Btn variant="secondary" disabled={!!busy || s.sim_day >= s.max_day} onClick={() => sim("NEXT_DAY")}>
            <SkipForward className="h-3.5 w-3.5" />Next day</Btn>
          <span className="text-[11px] text-muted-foreground" title="Use scripts/reset.sh --confirm during exclusive maintenance">Reset: maintenance only</span>
        </>
      ) : <span className="text-xs text-muted-foreground">Switch to Payments Ops Lead to control the simulation</span>}
    >
      {msg && <div className="mb-3 rounded-md border border-border bg-card px-3 py-2 text-xs">{msg}</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi title="Claims received" value={int(k.received)} sub={moneyShort(k.billed_total) + " billed"} />
        <Kpi title="Straight-through" value={pct(stpRate)} sub={`${int(k.straight_through)} with no human touch`} tone="good" />
        <Kpi title="Ready same day" value={pct(sameDay)} sub={`median ${minutes(k.median_minutes_to_ready)} · p95 ${minutes(k.p95_minutes_to_ready)}`} tone="good" />
        <Kpi title="Released" value={moneyShort(k.released_amt)} sub={`${moneyShort(k.ready_amt)} ready to batch`} />
        <Kpi title="Pending review" value={moneyShort(k.pending_amt)} sub={`${int(k.in_review)} claims in exception queue`} tone={k.in_review ? "warn" : "default"} />
        <Kpi title="Contract savings" value={moneyShort(k.pricing_savings)} sub="billed minus allowed (priced claims)" />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Section title="Claim flow" hint="Every claim is priced by the deterministic SQL engine; only rule hits go to review.">
          <Funnel k={k} />
          <div className="mt-3 rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
            <b className="text-foreground">{int(k.same_day_eligible)}</b> of {int(k.received)} providers&apos; claims are on ACH or
            virtual card (same-day capable). The rest go by check, which settles in 2 business days.
          </div>
        </Section>
        <Section title="Received vs payment-ready by hour" className="xl:col-span-2" hint="Simulated business hours, all days">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.timeline} margin={{ left: 0, right: 8, top: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={4} />
                <YAxis tick={{ fontSize: 10 }} width={40} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="received" name="Received" stroke="#64748b" fill="#64748b" fillOpacity={0.15} />
                <Area type="monotone" dataKey="ready" name="Payment-ready" stroke="#29b5e8" fill="#29b5e8" fillOpacity={0.3} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Section title="Time from receipt to payment-ready" hint="Straight-through claims vs claims that needed review">
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.timeToReady} margin={{ left: 0, right: 8, top: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} width={40} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="straight_through" name="Straight-through" stackId="a" fill="#29b5e8" />
                <Bar dataKey="after_review" name="After review" stackId="a" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
        <Section title="Exception queue" className="xl:col-span-2"
          hint={<>Agents proposed {int(data.agents.proposals)} resolutions · {int(data.agents.accepted)} accepted as-is ·{" "}
            {int(data.agents.overridden)} overridden · {int(data.agents.invalid)} rejected by contract validation</>}
          right={<Link href="/exceptions" className="text-xs font-medium text-[var(--brand-primary)] hover:underline">Open queue →</Link>}>
          <div className="max-h-64 overflow-auto">
            <table className="w-full">
              <thead><tr><Th>Stage</Th><Th>Type</Th><Th right>Total</Th><Th right>Open</Th><Th right>Proposed</Th><Th right>Resolved</Th><Th right>Escalated</Th><Th right>Avg open age</Th><Th right>Avg time to resolve</Th></tr></thead>
              <tbody>
                {data.aging.map((a) => (
                  <tr key={a.exception_type}>
                    <Td><StagePill stage={a.stage} /></Td><Td>{label(a.exception_type)}</Td><Td right>{int(a.total)}</Td>
                    <Td right>{int(a.open_new)}</Td><Td right>{int(a.proposed)}</Td><Td right>{int(a.resolved)}</Td>
                    <Td right>{int(a.escalated)}</Td><Td right>{minutes(a.avg_open_age_min)}</Td><Td right>{minutes(a.avg_minutes_to_resolve)}</Td>
                  </tr>
                ))}
                {!data.aging.length && <tr><Td className="text-muted-foreground">No exceptions yet: run the simulation.</Td></tr>}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <Section className="mt-4" title="Recent pipeline runs" hint="CORE.RUN_PIPELINE: intake AI → pricing → rules → routing → readiness">
        <table className="w-full">
          <thead><tr><Th>Started</Th><Th>Trigger</Th><Th>Sim time</Th><Th right>Duration</Th><Th right>Claims</Th><Th right>Documents</Th><Th right>Exceptions</Th><Th right>Ready</Th><Th>Status</Th></tr></thead>
          <tbody>
            {data.pipelineRuns.map((r) => (
              <tr key={r.started_at}>
                <Td>{shortTs(r.started_at)}</Td><Td>{label(r.trigger_source)}</Td><Td>{shortTs(r.sim_ts)}</Td>
                <Td right>{r.ms ? `${(r.ms / 1000).toFixed(1)} s` : "—"}</Td><Td right>{int(r.claims)}</Td><Td right>{int(r.attachments)}</Td>
                <Td right>{int(r.exceptions_opened)}</Td><Td right>{int(r.ready)}</Td><Td><StatusPill value={r.status === "OK" ? "RESOLVED" : r.status} /></Td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-muted-foreground">Money totals shown here: released {money(k.released_amt)}, ready {money(k.ready_amt)}.</p>
      </Section>
    </PageShell>
  )
}
