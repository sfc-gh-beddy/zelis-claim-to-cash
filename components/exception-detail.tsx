"use client"

import { useState } from "react"
import Link from "next/link"
import { useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ExternalLink, Sparkles } from "lucide-react"
import { AgentPanel } from "@/components/agent-panel"
import { usePersona } from "@/components/persona-switcher"
import { Btn, ErrorBox, Loading, Mono, PageShell, Section, StagePill, StatusPill, Td, Th, postJson, useApi } from "@/components/ui-kit"
import { canResolve } from "@/lib/personas"
import { label, money, pct, shortTs } from "@/lib/format"
import { cn } from "@/lib/utils"

type Detail = any

function PricingTrace({ snap }: { snap: any }) {
  if (!snap) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead><tr><Th>#</Th><Th>Code</Th><Th>Mods</Th><Th right>Units</Th><Th right>Billed</Th><Th>Method</Th><Th right>Base</Th>
          <Th right>Mod factor</Th><Th right>Rate</Th><Th right>Allowed</Th></tr></thead>
        <tbody>
          {(snap.lines ?? []).map((l: any) => (
            <tr key={l.line_no}>
              <Td>{l.line_no}</Td>
              <Td><Mono>{l.code}</Mono>{l.billed_code !== l.code && <span className="ml-1 text-[10px] text-amber-600">billed {l.billed_code}</span>}</Td>
              <Td>{(l.mods ?? []).join(", ") || "—"}</Td><Td right>{l.units}</Td><Td right>{money(l.billed)}</Td>
              <Td><span className={cn("text-[11px]", ["CARVEOUT_CONFLICT", "NEEDS_INVOICE"].includes(l.method) && "font-semibold text-amber-600")}>{label(l.method)}</span>
                {l.carveout && <div className="text-[10px] text-muted-foreground">{l.carveout.source}</div>}
                {l.invoice_cost && <div className="text-[10px] text-muted-foreground">invoice {money(l.invoice_cost)} ({label(l.invoice_source)})</div>}</Td>
              <Td right>{money(l.base_rate)}</Td><Td right>{l.modifier_factor ?? "—"}</Td><Td right>{l.pct ? `${l.pct}%` : "—"}</Td>
              <Td right className="font-medium">{l.allowed === null ? <span className="text-amber-600">unresolved</span> : money(l.allowed)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-muted-foreground">
        <span>Contract <Mono>{snap.contract_id ?? "none (out-of-network policy)"}</Mono></span>
        <span>Network {label(snap.network_kind)}</span>
        {snap.stop_loss && <span className="text-amber-600">Stop-loss applies · non-covered {money(snap.non_covered)} ({label(snap.non_covered_source)})</span>}
        {snap.capped_at_billed && <span>Capped at billed charges</span>}
      </div>
    </div>
  )
}

function Documents({ docs }: { docs: any[] }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!docs.length) return <p className="text-xs text-muted-foreground">No attachments on this claim.</p>
  return (
    <div className="space-y-2">
      {docs.map((d) => (
        <div key={d.attachment_id} className="rounded-lg border border-border p-2.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{label(d.doc_type)}</span>
            {d.scanned && <span className="rounded bg-muted px-1.5 text-[10px]">scanned image → OCR</span>}
            <StatusPill value={d.status === "OK" ? "RESOLVED" : d.status === "LOW_CONFIDENCE" ? "EXCEPTION" : d.status} />
            {d.attempts > 1 && <span className="text-[10px] text-muted-foreground">OCR attempts: {d.attempts}</span>}
            {d.url && <a className="ml-auto inline-flex items-center gap-1 text-[var(--brand-primary)] hover:underline" href={d.url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3 w-3" />Open PDF</a>}
          </div>
          {d.fields && (
            <table className="mt-2 w-full">
              <tbody>
                {Object.entries(d.fields).filter(([, v]) => v !== "None" && v !== null).map(([k, v]) => {
                  const score = d.scores?.[k]?.score
                  return (
                    <tr key={k}>
                      <Td className="w-48 text-muted-foreground">{label(k)}</Td>
                      <Td>{Array.isArray(v) ? (v as unknown[]).join("; ") : String(v)}</Td>
                      <Td right className={cn(score !== undefined && score < 0.85 && "text-amber-600")}>{score !== undefined ? score.toFixed(2) : ""}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <button className="mt-1 text-[11px] text-muted-foreground hover:underline" onClick={() => setOpen(open === d.attachment_id ? null : d.attachment_id)}>
            {open === d.attachment_id ? "Hide" : "Show"} OCR text
          </button>
          {open === d.attachment_id && <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px]">{d.parsed_text}</pre>}
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">AI_PARSE_DOCUMENT (OCR) → AI_CLASSIFY → AI_EXTRACT with per-field confidence. Money fields below 0.85 are not used by the pricing engine.</p>
    </div>
  )
}

function ProposalCard({ p }: { p: any }) {
  return (
    <div className="rounded-xl border-2 border-violet-300 bg-violet-50/40 p-4 dark:border-violet-800 dark:bg-violet-950/20">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 text-violet-600" />
        <span className="text-sm font-semibold">Agent proposal: {label(p.decision)}</span>
        <StatusPill value={p.status} />
        {!p.contract_valid && <span className="rounded bg-red-100 px-1.5 text-[10px] text-red-700">failed contract check: {p.contract_issues.join(", ")}</span>}
        <span className="ml-auto text-xs text-muted-foreground">{label(p.agent_name)} · confidence {pct(p.confidence, 0)}</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-3 text-xs">
        <div><div className="text-muted-foreground">Current allowed</div><div className="text-base font-semibold tabular-nums">{p.current_allowed_amt === null ? "unresolved" : money(p.current_allowed_amt)}</div></div>
        <div><div className="text-muted-foreground">Proposed allowed (engine dry-run)</div><div className="text-base font-semibold tabular-nums">{money(p.proposed_allowed_amt)}</div></div>
        <div><div className="text-muted-foreground">Adjustments</div><div className="font-mono text-[11px]">{(p.adjustments ?? []).map((a: any) => `${a.action}${a.value_str ? `=${a.value_str}` : ""}${a.line_no ? ` L${a.line_no}` : ""}`).join(", ") || "none"}</div></div>
      </div>
      <p className="mt-3 text-sm leading-relaxed">{p.rationale}</p>
      {(p.citations ?? []).length > 0 && (
        <div className="mt-3 space-y-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Evidence</div>
          {p.citations.map((c: any, i: number) => (
            <div key={i} className="rounded border-l-2 border-violet-400 bg-background/70 px-2 py-1 text-xs">
              <span className="mr-1 rounded bg-muted px-1 text-[10px] uppercase">{c.source}</span><Mono>{c.ref}</Mono>
              {c.quote && <span className="ml-1 italic text-muted-foreground">&ldquo;{c.quote}&rdquo;</span>}
            </div>
          ))}
        </div>
      )}
      {(p.risk_flags ?? []).length > 0 && (
        <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-amber-800 dark:text-amber-300">
          {p.risk_flags.map((f: string, i: number) => <li key={i}>{f}</li>)}
        </ul>
      )}
    </div>
  )
}

export function ExceptionDetail({ id }: { id: string }) {
  const qc = useQueryClient()
  const { data: persona } = usePersona()
  const { data, error, isLoading, refetch } = useApi<Detail>(["exception", id], `/api/exceptions/${encodeURIComponent(id)}`)
  const [decision, setDecision] = useState<string>("")
  const [value, setValue] = useState<string>("")
  const [note, setNote] = useState("")
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [triage, setTriage] = useState<any>(null)

  if (isLoading) return <PageShell title="Exception"><Loading /></PageShell>
  if (error || !data) return <PageShell title="Exception"><ErrorBox error={error} /></PageShell>
  const e = data.exception, c = data.claim
  const latest = data.proposals.find((p: any) => p.status === "PENDING") ?? data.proposals[0]
  const closed = ["RESOLVED", "ESCALATED"].includes(e.status)
  const allowed = persona ? canResolve(persona.current, e.stage, e.exception_type) : false
  const chosen = decision || (latest?.status === "PENDING" ? latest.decision : "")
  const needsValue = data.decisions.find((d: any) => d.decision === chosen)?.needs_value

  async function resolve() {
    setBusy(true); setResult(null)
    const r = await postJson(`/api/exceptions/${encodeURIComponent(id)}/resolve`, {
      expectedVersion: e.version, decision: chosen, value: value ? Number(value) : null,
      proposalId: latest?.proposal_id ?? null, note, idempotencyKey: crypto.randomUUID() })
    setResult({ ok: r.ok, ...r.data }); setBusy(false)
    await refetch(); await qc.invalidateQueries({ queryKey: ["exceptions"] })
  }
  async function runTriage() {
    setTriage({ loading: true })
    const r = await postJson(`/api/exceptions/${encodeURIComponent(id)}/triage`, {})
    setTriage(r.data)
  }

  return (
    <PageShell
      title={`${label(e.exception_type)} · ${c.claim_id}`}
      subtitle={<span className="flex flex-wrap items-center gap-2"><StagePill stage={e.stage} /><StatusPill value={e.status} />
        <span>{e.rule_title}</span><Mono>{e.rule_id} v{e.rule_version}</Mono><span>opened {shortTs(e.opened_sim_ts)} (sim)</span></span>}
      actions={<Link href="/exceptions" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"><ArrowLeft className="h-3 w-3" />Queue</Link>}>
      <div className="grid gap-4 xl:grid-cols-5">
        <div className="space-y-4 xl:col-span-3">
          <Section title="Claim" right={<StatusPill value={c.claim_status} />}>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-4">
              <div><span className="text-muted-foreground">Payer</span><div className="font-medium">{c.payer_name}</div></div>
              <div><span className="text-muted-foreground">Provider</span><div className="font-medium">{c.org_name}</div><div className="text-[11px] text-muted-foreground">{c.provider_name} · NPI {c.npi} · TIN {c.tin}</div></div>
              <div><span className="text-muted-foreground">Service date · frequency</span><div className="font-medium">{String(c.service_from).slice(0, 10)} · {c.frequency_code}</div></div>
              <div><span className="text-muted-foreground">Pay method</span><div className="font-medium">{c.pay_method}{c.same_day_eligible ? " (same-day)" : " (not same-day)"}</div></div>
              <div><span className="text-muted-foreground">Billed</span><div className="text-base font-semibold tabular-nums">{money(c.billed_amt)}</div></div>
              <div><span className="text-muted-foreground">Allowed (engine)</span><div className="text-base font-semibold tabular-nums">{c.allowed_amt === null ? "unresolved" : money(c.allowed_amt)}</div></div>
              <div><span className="text-muted-foreground">Payable</span><div className="text-base font-semibold tabular-nums">{money(c.payable_amt)}</div></div>
              <div><span className="text-muted-foreground">Rule predicate</span><div className="font-mono text-[10px] text-muted-foreground">{e.predicate_sql}</div></div>
            </div>
          </Section>
          <Section title="Deterministic pricing trace" hint="CORE.PRICE_WORK: contract terms × reference base rate × modifier factors. No model involved.">
            <PricingTrace snap={c.pricing_snapshot} />
          </Section>
          <Section title="Attachments" hint="Intake AI on the claim's documents">
            <Documents docs={data.documents} />
          </Section>
        </div>

        <div className="space-y-4 xl:col-span-2">
          <Section title="Quick triage" hint="Claude Haiku via Cortex AI Gateway (attributed to this claim)"
            right={<Btn variant="secondary" onClick={runTriage} disabled={triage?.loading}>{triage?.loading ? "…" : "Summarize"}</Btn>}>
            {(triage?.summary || data.triage) ? (() => {
              const t = triage?.summary ?? (() => { try { return JSON.parse(data.triage.output.slice(data.triage.output.indexOf("{"))) } catch { return null } })()
              return t ? (<div className="text-xs"><p className="font-medium">{t.headline}</p>
                <ul className="mt-1 list-disc pl-5">{t.what_to_check?.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>
                </div>)
                : <p className="text-xs text-muted-foreground">Last triage failed validation.</p>
            })() : triage && !triage.loading ? <p className="text-xs text-red-600">{triage.error}</p>
              : <p className="text-xs text-muted-foreground">One-line summary of what a reviewer should check.</p>}
          </Section>

          <AgentPanel key={id} exceptionId={id} disabled={closed} onDone={() => { void refetch() }} />
          {latest && <ProposalCard p={latest} />}

          <Section title={closed ? "Resolution" : "Decide"}
            hint={closed ? undefined : allowed ? `Acting as ${persona?.current.person} (${persona?.current.label})`
              : `${persona?.current.label} cannot resolve this. Switch persona in the header.`}>
            {closed ? (
              <div className="text-xs">
                <p><b>{label(e.resolution?.decision)}</b> by {e.resolved_by} ({label(e.resolution?.persona)}) at {shortTs(e.resolved_sim_ts)} (sim)</p>
                {e.resolution?.proposal_id && <p className="mt-1">{e.resolution.agreed_with_agent ? "Accepted the agent proposal." : `Overrode agent proposal (${label(e.resolution.agent_decision)}).`}</p>}
                {e.resolution?.note && <p className="mt-1 text-muted-foreground">Note: {e.resolution.note}</p>}
              </div>
            ) : (
              <div className="space-y-2">
                {data.decisions.map((d: any) => (
                  <label key={d.decision} className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs",
                    chosen === d.decision ? "border-[var(--brand-primary)] bg-[var(--brand-primary)]/5" : "border-border")}>
                    <input type="radio" name="decision" className="mt-0.5" checked={chosen === d.decision} onChange={() => setDecision(d.decision)} />
                    <span><b>{d.label}</b>{latest?.decision === d.decision && <span className="ml-1 text-violet-600">(agent)</span>}
                      <span className="block text-muted-foreground">{d.description}{d.outcome === "ESCALATED" ? " · keeps payment on hold" : ""}</span></span>
                  </label>
                ))}
                {needsValue && <input type="number" step="0.01" min="0" placeholder="Verified amount from the document"
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs" value={value} onChange={(ev) => setValue(ev.target.value)} />}
                <textarea placeholder="Note for the audit log (optional)" className="h-14 w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                  value={note} onChange={(ev) => setNote(ev.target.value)} />
                <Btn onClick={resolve} disabled={!chosen || busy || !allowed || (needsValue && !value)}>
                  {busy ? "Saving…" : latest?.status === "PENDING" && chosen === latest.decision ? "Approve agent proposal" : "Resolve with this decision"}</Btn>
              </div>
            )}
            {result && (
              <p className={cn("mt-2 text-xs", result.ok ? "text-emerald-700" : "text-red-600")}>
                {result.ok ? `Saved. Claim is now ${label(result.claim_status)} at ${money(result.allowed_amt)}.`
                  : `${result.code ?? "Error"}: ${result.message ?? result.error ?? ""}`}</p>
            )}
          </Section>

          <Section title="Audit trail" hint="OPS.AUDIT_LOG (append-only)">
            <ul className="space-y-1 text-xs">
              {data.audit.map((a: any, i: number) => (
                <li key={i} className="flex gap-2"><span className="w-32 shrink-0 text-muted-foreground">{shortTs(a.event_ts)}</span>
                  <span><b>{label(a.action)}</b> · {a.actor} ({label(a.persona)})</span></li>
              ))}
              {!data.audit.length && <li className="text-muted-foreground">No events yet.</li>}
            </ul>
          </Section>
        </div>
      </div>
    </PageShell>
  )
}
