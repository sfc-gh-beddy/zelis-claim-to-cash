"use client"

import { ErrorBox, Loading, Mono, PageShell, Section, StatusPill, useApi } from "@/components/ui-kit"
import { int, label } from "@/lib/format"
import { cn } from "@/lib/utils"

function Node({ title, tech, children, tone = "default" }:
  { title: string; tech: string; children?: React.ReactNode; tone?: "default" | "ai" | "human" | "money" }) {
  const t = { default: "border-border", ai: "border-violet-300 bg-violet-50/50 dark:border-violet-800 dark:bg-violet-950/20",
    human: "border-amber-300 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20",
    money: "border-emerald-300 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20" }[tone]
  return (
    <div className={cn("rounded-lg border p-2.5 text-xs", t)}>
      <div className="font-semibold">{title}</div>
      <div className="text-[10px] text-muted-foreground">{tech}</div>
      {children && <div className="mt-1.5 space-y-0.5">{children}</div>}
    </div>
  )
}
const Arrow = () => <div className="flex items-center justify-center text-muted-foreground">→</div>

export function ArchitectureView() {
  const { data, error, isLoading } = useApi<any>(["architecture"], "/api/architecture", 20000)
  if (isLoading) return <PageShell title="Architecture"><Loading /></PageShell>
  if (error || !data) return <PageShell title="Architecture"><ErrorBox error={error} /></PageShell>
  const c = data.counts ?? {}
  const task = data.tasks[0]
  return (
    <PageShell title="Architecture" subtitle={<>Live objects in <Mono>{data.runtime.account}</Mono> ({data.runtime.region}) ·
      app running as <Mono>{data.runtime.role}</Mono> · {data.runtime.mode === "app-runtime" ? "Snowflake App Runtime (service token)" : "local dev (PAT)"}</>}>
      <Section title="Claim-to-cash flow" hint="Purple = AI, amber = a person decides, green = money moves. Everything runs inside the Snowflake account.">
        <div className="grid items-stretch gap-2 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr]">
          <Node title="1 · Intake" tech="Task OPS.T_SIM_TICK → RAW.CLAIMS + @RAW.INTAKE">
            <div>{int(c.claims)} claims · {int(c.attachments)} attachments</div>
            <div>Task: <StatusPill value={task?.state === "started" ? "RUNNING" : "PAUSED"} /></div>
          </Node><Arrow />
          <Node title="2 · Document AI" tech="AI_PARSE_DOCUMENT (OCR) · AI_CLASSIFY · AI_EXTRACT (scored)" tone="ai">
            <div>{int(c.extracts)} documents extracted</div><div>Money fields gated at score ≥ 0.85</div>
          </Node><Arrow />
          <Node title="3 · Pricing + rules" tech="CORE.PRICE_WORK · CORE.RUN_RULES (rules as data)">
            <div>{int(c.active_rules)} active rules · {int(c.exceptions)} exceptions</div><div>Deterministic, NUMBER(18,2)</div>
          </Node><Arrow />
          <Node title="4 · Exception agents" tech="3 Cortex Agents · Agent SDK · Search · Analyst" tone="ai">
            <div>{int(c.proposals)} proposals (propose-only tools)</div><div>Dry-run via the same pricing engine</div>
          </Node><Arrow />
          <Node title="5 · Approve + release" tech="RESOLVE_EXCEPTION · APPROVE_BATCH · RELEASE_BATCH" tone="money">
            <div>{int(c.batches)} batches · rail simulator · 835</div><div>{int(c.audit_events)} audit events</div>
          </Node>
        </div>
        <div className="mt-2 grid gap-2 lg:grid-cols-3">
          <Node title="People" tech="Persona-gated endpoints + checks inside every procedure" tone="human">
            <div>Pricing Analyst · Integrity Reviewer · Payment Approver ($250K) · Ops Lead</div>
            <div>Idempotency keys, optimistic versions, segregation of duties</div>
          </Node>
          <Node title="Cortex AI Gateway" tech="Anthropic Messages API · conversation id = claim id" tone="ai">
            {data.gateways.map((g: any) => <div key={g.name}><Mono>{g.name}</Mono> {String(g.base_url ?? "").replace(/^https:\/\//, "")}</div>)}
            <div>Triage summaries, EOP letters (numbers validated against SQL)</div>
          </Node>
          <Node title="Application" tech="Next.js on Snowflake App Runtime (SPCS)">
            <div>Owner&apos;s-rights service token for SQL + REST</div><div>Warehouse {data.warehouse[0]?.name} ({data.warehouse[0]?.size}, {data.warehouse[0]?.state})</div>
          </Node>
        </div>
      </Section>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Section title="Cortex Agents">{data.agents.map((a: any) => (
          <div key={a.name} className="mb-2 text-xs"><Mono>{a.name}</Mono><p className="text-muted-foreground">{a.comment}</p></div>))}</Section>
        <Section title="Cortex Search services">{data.search.map((s: any) => (
          <div key={s.name} className="mb-2 flex items-center gap-2 text-xs"><Mono>{s.name}</Mono>
            <StatusPill value={s.serving_state === "ACTIVE" ? "RESOLVED" : s.serving_state} /><span className="text-muted-foreground">{int(Number(s.source_data_num_rows))} chunks</span></div>))}
          <p className="text-[11px] text-muted-foreground">{int(c.chunks)} section-level chunks from contracts and payer policies</p></Section>
        <Section title="Semantic view + task">{data.semanticViews.map((v: any) => (
          <div key={v.name} className="mb-2 text-xs"><Mono>{v.name}</Mono><p className="text-muted-foreground">{v.comment}</p></div>))}
          {data.tasks.map((t: any) => <div key={t.name} className="text-xs"><Mono>{t.name}</Mono> · {t.schedule} · {label(t.state)}</div>)}
        </Section>
      </div>
      <Section className="mt-4" title="Stored procedures" hint="Every state change in the app goes through one of these">
        <div className="flex flex-wrap gap-1.5">{data.procedures.map((p: any) => <Mono key={p.name}>{p.name}</Mono>)}</div>
      </Section>
    </PageShell>
  )
}
