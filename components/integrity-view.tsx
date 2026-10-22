"use client"

import Link from "next/link"
import { ErrorBox, Kpi, Loading, Mono, PageShell, Section, StatusPill, Td, Th, useApi } from "@/components/ui-kit"
import { int, label, money, moneyShort, pct, shortTs } from "@/lib/format"

export function IntegrityView() {
  const { data, error, isLoading } = useApi<any>(["integrity"], "/api/integrity", 8000)
  if (isLoading) return <PageShell title="Payment integrity"><Loading /></PageShell>
  if (error || !data) return <PageShell title="Payment integrity"><ErrorBox error={error} /></PageShell>
  const integrityRules = data.rules.filter((r: any) => r.stage === "INTEGRITY")
  const flags = integrityRules.reduce((a: number, r: any) => a + (r.flags ?? 0), 0)
  const adverse = integrityRules.reduce((a: number, r: any) => a + (r.adverse ?? 0), 0)
  const cleared = integrityRules.reduce((a: number, r: any) => a + (r.cleared ?? 0), 0)
  return (
    <PageShell title="Payment integrity"
      subtitle="Pre-payment rules (stored as data in CORE.RULES, versioned) flag claims; agents explain; reviewers decide.">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi title="Integrity flags" value={int(flags)} sub={`${int(integrityRules.length)} active rules`} />
        <Kpi title="Confirmed (adverse)" value={int(adverse)} sub="denied, bundled or downcoded" tone="warn" />
        <Kpi title="Cleared" value={int(cleared)} sub="legitimate on review" tone="good" />
        <Kpi title="Overpayment avoided" value={moneyShort(data.avoided)} sub="accepted proposals, before vs after" tone="good" />
      </div>
      <Section className="mt-4" title="Rules" hint="Every rule, all stages. Predicates run against one row per claim line (CORE.W_RULE_FEATURES).">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr><Th>Rule</Th><Th>Stage</Th><Th>Exception type</Th><Th>Predicate</Th><Th>Owner</Th><Th right>Flags</Th><Th right>Open</Th><Th right>Adverse</Th><Th right>Cleared</Th></tr></thead>
            <tbody>{data.rules.map((r: any) => (
              <tr key={r.rule_id + r.version}>
                <Td><div className="font-medium">{r.title}</div><Mono>{r.rule_id} v{r.version}</Mono> <StatusPill value={r.status === "ACTIVE" ? "RESOLVED" : r.status} /></Td>
                <Td>{r.stage}</Td><Td>{label(r.exception_type)}</Td>
                <Td><code className="block max-w-md whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">{r.predicate_sql}</code></Td>
                <Td>{label(r.owner_persona)}</Td><Td right>{int(r.flags)}</Td><Td right>{int(r.open)}</Td><Td right>{int(r.adverse)}</Td><Td right>{int(r.cleared)}</Td>
              </tr>))}</tbody>
          </table>
        </div>
      </Section>
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Section title="Integrity flags" className="xl:col-span-2">
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full">
              <thead><tr><Th>Claim</Th><Th>Type</Th><Th>Provider</Th><Th right>Billed</Th><Th>Agent explanation</Th><Th>Disposition</Th></tr></thead>
              <tbody>{data.flags.map((f: any) => (
                <tr key={f.exception_id}>
                  <Td><Link className="font-mono text-[11px] text-[var(--brand-primary)] hover:underline" href={`/exceptions/${encodeURIComponent(f.exception_id)}`}>{f.claim_id}</Link>
                    <div className="text-[10px] text-muted-foreground">{shortTs(f.opened_sim_ts)}</div></Td>
                  <Td>{label(f.exception_type)}<div className="text-[10px] text-muted-foreground">{f.rule_id} v{f.rule_version}</div></Td>
                  <Td>{f.org_name}</Td><Td right>{money(f.billed_amt)}</Td>
                  <Td>{f.proposed ? <div><b>{label(f.proposed)}</b> · {pct(f.confidence, 0)}<p className="line-clamp-2 text-[11px] text-muted-foreground">{f.rationale}</p></div>
                    : <span className="text-muted-foreground">—</span>}</Td>
                  <Td><StatusPill value={f.status} />{f.resolved_decision && <div className="text-[10px]">{label(f.resolved_decision)} · {f.resolved_by}</div>}</Td>
                </tr>))}</tbody>
            </table>
          </div>
        </Section>
        <Section title="Level-5 E/M share by provider" hint="Basis of the pre-payment review list (prepay = flagged outlier)">
          <table className="w-full"><thead><tr><Th>Provider</Th><Th right>Claims</Th><Th right>99215 share</Th><Th>Prepay</Th></tr></thead>
            <tbody>{data.providers.map((p: any) => (
              <tr key={p.org_name}><Td>{p.org_name}<div className="text-[10px] text-muted-foreground">{p.specialty}</div></Td>
                <Td right>{int(p.claims)}</Td><Td right>{pct(p.level5_share, 0)}</Td><Td>{p.prepay_review ? "yes" : ""}</Td></tr>))}</tbody></table>
        </Section>
      </div>
    </PageShell>
  )
}
