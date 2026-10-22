"use client"

import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Banknote, FileText, Layers, ShieldCheck } from "lucide-react"
import { usePersona } from "@/components/persona-switcher"
import { Btn, ErrorBox, Kpi, Loading, PageShell, Section, StatusPill, Td, Th, postJson, useApi } from "@/components/ui-kit"
import { canApproveBatch } from "@/lib/personas"
import { int, label, money, moneyShort, simClock } from "@/lib/format"

type Batch = { batch_id: string; payer_id: string; payer_name: string; pay_method: string; status: string; claim_count: number
  total_amt: number; max_claim_amt: number; created_by: string; approved_by: string | null; released_by: string | null
  expected_settlement_date: string | null; cutoff_met: boolean | null; version: number; resolvers: string[] }
type Payments = {
  readiness: Array<{ status: string; pay_method: string; n: number; amt: number }>
  blockers: Array<{ blocker: string; stage: string; claims: number; amt: number }>
  batches: Batch[]
  clock: { sim_minute: number; ach_cutoff_minute: number; ach_cutoff_passed: boolean }
}

function Remittance({ batchId }: { batchId: string }) {
  const { data, isLoading, refetch } = useApi<any>(["remit", batchId], `/api/payments/${batchId}/remittance`)
  const [drafting, setDrafting] = useState(false)
  if (isLoading) return <Loading what="Loading remittance" />
  return (
    <div className="mt-2 grid gap-3 lg:grid-cols-2">
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Rail ledger (simulator adapter)</div>
        <div className="max-h-48 overflow-auto rounded border border-border">
          <table className="w-full"><thead><tr><Th>Provider</Th><Th>Rail</Th><Th right>Amount</Th><Th>Trace</Th><Th>Settles</Th></tr></thead>
            <tbody>{data?.ledger.map((l: any) => (
              <tr key={l.org_id}><Td>{l.org_name}</Td><Td>{l.rail}</Td><Td right>{money(l.amount)}</Td><Td className="font-mono">{l.trace_number}</Td>
                <Td>{String(l.expected_settlement_date).slice(0, 10)}</Td></tr>))}</tbody></table>
        </div>
        <div className="mb-1 mt-3 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">EOP cover letters (gateway · numbers verified against SQL)</span>
          <Btn variant="secondary" disabled={drafting} onClick={async () => { setDrafting(true); await postJson(`/api/payments/${batchId}/remittance`, {}); setDrafting(false); void refetch() }}>
            {drafting ? "Drafting…" : "Draft for top providers"}</Btn>
        </div>
        {data?.letters.map((l: any) => (
          <div key={l.org_id} className="mb-2 rounded border border-border p-2 text-xs">
            <div className="flex items-center gap-2"><b>{l.org_name}</b><span>{money(l.amount)}</span>
              <StatusPill value={l.validated ? "ACCEPTED" : "INVALID"} /></div>
            {l.letter ? <p className="mt-1 whitespace-pre-wrap leading-relaxed">{l.letter}</p>
              : <p className="mt-1 text-red-600">Rejected: {JSON.stringify(typeof l.validation === "string" ? JSON.parse(l.validation) : l.validation)}</p>}
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">835 remittance · {data?.file?.file_path}</div>
        <pre className="max-h-[26rem] overflow-auto rounded bg-slate-950 p-2 font-mono text-[10px] leading-snug text-emerald-200">{data?.file?.content?.replace(/~/g, "~\n").slice(0, 12000)}</pre>
        <p className="mt-1 text-[10px] text-muted-foreground">Simplified 835 segments (ISA/GS/ST/BPR/TRN/N1/CLP/NM1/CAS/SE/GE/IEA), written to @OPS.REMITTANCE. Not a certified X12 implementation.</p>
      </div>
    </div>
  )
}

export function PaymentsView() {
  const qc = useQueryClient()
  const { data: persona } = usePersona()
  const { data, error, isLoading } = useApi<Payments>(["payments"], "/api/payments", 6000)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [retry, setRetry] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!data || !persona) return
    setRetry(Object.fromEntries(data.batches.map(batch => [batch.batch_id,
      sessionStorage.getItem(`c2c-payment:${persona.current.id}:${batch.batch_id}:release`) !== null])))
  }, [data, persona])

  if (isLoading) return <PageShell title="Payments"><Loading /></PageShell>
  if (error || !data) return <PageShell title="Payments"><ErrorBox error={error} /></PageShell>
  const p = persona?.current

  async function act(b: Batch, action: "approve" | "release") {
    if (busy !== null) return
    setBusy(b.batch_id + action)
    const key = `c2c-payment:${p?.id}:${b.batch_id}:${action}`
    try {
      const saved = sessionStorage.getItem(key)
      const request = saved ? JSON.parse(saved) : { expectedVersion: b.version, idempotencyKey: crypto.randomUUID() }
      sessionStorage.setItem(key, JSON.stringify(request))
      const r = await postJson(`/api/payments/${b.batch_id}/${action}`, request)
      const exportPending = r.ok && action === "release" && r.data.remittance_export !== "EXPORTED"
      if ((r.ok && !exportPending) || (r.status >= 400 && r.status < 500)) sessionStorage.removeItem(key)
      setRetry(previous => ({ ...previous, [b.batch_id]: exportPending || !r.ok }))
      setMsg(m => ({ ...m, [b.batch_id]: r.ok
        ? action === "release" ? `Simulated release committed; expected settlement ${String(r.data.expected_settlement_date).slice(0, 10)}. ${exportPending ? "Remittance export pending: retry uses the same request, not a second payment." : "Remittance exported."}` : "Approved"
        : `${r.data.code ?? "Error"}: ${r.data.error ?? r.data.message ?? ""}` }))
    } catch (error) {
      setRetry(previous => ({ ...previous, [b.batch_id]: true }))
      setMsg(m => ({ ...m, [b.batch_id]: `Outcome unknown: ${(error as Error).message}. Retry preserves the original request key.` }))
    } finally {
      setBusy(null)
      await qc.invalidateQueries({ queryKey: ["payments"] })
    }
  }
  async function create() {
    setBusy("create")
    const key = `c2c-batch-create:${p?.id}`
    try {
      const saved = sessionStorage.getItem(key)
      const request = saved ? JSON.parse(saved) : { idempotencyKey: crypto.randomUUID() }
      sessionStorage.setItem(key, JSON.stringify(request))
      const r = await postJson("/api/payments", request)
      if (r.ok || (r.status >= 400 && r.status < 500)) sessionStorage.removeItem(key)
      setMsg(m => ({ ...m, create: r.ok ? `Created ${r.data.batches} batches with ${r.data.claims} claims (${moneyShort(r.data.total_amt)})` : r.data.error ?? r.data.code }))
    } catch (error) {
      setMsg(m => ({ ...m, create: `Outcome unknown: ${(error as Error).message}. Retry preserves the original request.` }))
    } finally {
      setBusy(null)
      await qc.invalidateQueries()
    }
  }

  const sum = (st: string[]) => data.readiness.filter((r) => st.includes(r.status)).reduce((a, r) => a + (r.amt ?? 0), 0)
  const cnt = (st: string[]) => data.readiness.filter((r) => st.includes(r.status)).reduce((a, r) => a + (r.n ?? 0), 0)

  return (
    <PageShell title="Payments"
      subtitle={<>Sim clock {simClock(data.clock.sim_minute)} · same-day ACH cut-off 14:45 {data.clock.ach_cutoff_passed
        ? <b className="text-amber-600">passed: ACH released now settles next business day</b> : <b className="text-emerald-600">open</b>}</>}
      actions={p?.canCreateBatches ? <Btn onClick={create} disabled={busy === "create"}><Layers className="h-3.5 w-3.5" />{busy === "create" ? "Batching…" : "Batch all ready claims"}</Btn>
        : <span className="text-xs text-muted-foreground">{p?.label} cannot create batches</span>}>
      {msg.create && <div className="mb-3 rounded-md border border-border bg-card px-3 py-2 text-xs">{msg.create}</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi title="Ready to batch" value={moneyShort(sum(["READY"]))} sub={`${int(cnt(["READY"]))} claims`} tone="good" />
        <Kpi title="Batched, awaiting approval/release" value={moneyShort(sum(["BATCHED"]))} sub={`${int(cnt(["BATCHED"]))} claims`} />
        <Kpi title="Released" value={moneyShort(sum(["RELEASED"]))} sub={`${int(cnt(["RELEASED"]))} claims`} />
        <Kpi title="Blocked" value={moneyShort(sum(["EXCEPTION", "HELD", "OFFER_PENDING"]))} sub={`${int(cnt(["EXCEPTION", "HELD", "OFFER_PENDING"]))} claims`} tone="warn" />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Section title="What is blocking same-day payment" hint="Open exceptions and slow rails">
          <table className="w-full"><thead><tr><Th>Blocker</Th><Th right>Claims</Th><Th right>Amount</Th></tr></thead>
            <tbody>{data.blockers.map((b) => (<tr key={b.blocker}><Td>{label(b.blocker)}</Td><Td right>{int(b.claims)}</Td><Td right>{moneyShort(b.amt)}</Td></tr>))}</tbody></table>
        </Section>
        <Section title="Payment batches" className="xl:col-span-2"
          hint={<>Approval matrix: Payment Approver up to $250,000 per batch and $50,000 per claim; Ops Lead unlimited. Whoever resolved an
            exception in a batch cannot approve it.</>}>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr><Th>Batch</Th><Th>Payer</Th><Th>Rail</Th><Th right>Claims</Th><Th right>Total</Th><Th right>Largest</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
              <tbody>
                {data.batches.map((b) => {
                  const lim = p ? canApproveBatch(p, b.total_amt, b.max_claim_amt) : { ok: false as const, reason: "" }
                  const sod = p && b.resolvers?.includes(p.person)
                  return (
                    <tr key={b.batch_id} className="align-top">
                      <Td><button className="font-mono text-[11px] text-[var(--brand-primary)] hover:underline disabled:no-underline disabled:text-foreground" disabled={b.status !== "RELEASED"}
                        onClick={() => setOpen(open === b.batch_id ? null : b.batch_id)}>{b.batch_id}</button>
                        {open === b.batch_id && <Remittance batchId={b.batch_id} />}
                        {msg[b.batch_id] && <div className="mt-1 text-[11px]">{msg[b.batch_id]}</div>}</Td>
                      <Td>{b.payer_name}</Td><Td>{b.pay_method}</Td><Td right>{int(b.claim_count)}</Td><Td right>{money(b.total_amt)}</Td>
                      <Td right>{money(b.max_claim_amt)}</Td>
                      <Td><StatusPill value={b.status} />{b.status === "RELEASED" && <div className="mt-0.5 text-[10px] text-muted-foreground">
                        settles {String(b.expected_settlement_date).slice(0, 10)}{b.cutoff_met === false ? " (missed cut-off)" : ""}</div>}</Td>
                      <Td>
                        {b.status === "DRAFT" && (
                          <Btn variant="secondary" disabled={!lim.ok || !!sod || busy !== null} onClick={() => act(b, "approve")}
                            title={!lim.ok ? lim.reason : sod ? "Segregation of duties: you resolved an exception in this batch" : "Approve"}>
                            <ShieldCheck className="h-3.5 w-3.5" />Approve</Btn>)}
                        {b.status === "APPROVED" && (
                          <Btn disabled={!p?.canRelease || busy !== null} onClick={() => act(b, "release")}>
                            <Banknote className="h-3.5 w-3.5" />Release</Btn>)}
                        {b.status === "RELEASED" && retry[b.batch_id] && <Btn disabled={!p?.canRelease || busy !== null} onClick={() => act(b, "release")}>Retry export</Btn>}
                        {b.status === "RELEASED" && <Btn variant="ghost" onClick={() => setOpen(open === b.batch_id ? null : b.batch_id)}><FileText className="h-3.5 w-3.5" />Remittance</Btn>}
                        {b.status === "DRAFT" && !lim.ok && <div className="mt-1 text-[10px] text-muted-foreground">{lim.reason}</div>}
                        {b.status === "DRAFT" && sod && <div className="mt-1 text-[10px] text-amber-600">You resolved an exception here</div>}
                      </Td>
                    </tr>
                  )
                })}
                {!data.batches.length && <tr><Td className="text-muted-foreground">No batches yet.</Td></tr>}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </PageShell>
  )
}
