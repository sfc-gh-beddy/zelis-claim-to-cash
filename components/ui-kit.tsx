"use client"

import { useQuery } from "@tanstack/react-query"
import type React from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { label } from "@/lib/format"

export function useApi<T>(key: unknown[], url: string, refetchMs?: number) {
  return useQuery<T>({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(url, { cache: "no-store" })
      const body = await r.json()
      if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`)
      return body as T
    },
    refetchInterval: refetchMs,
  })
}

export async function postJson<T = any>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, data }
}

export function PageShell({ title, subtitle, actions, children }:
  { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[1500px] px-5 py-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </main>
  )
}

export function Section({ title, hint, right, children, className }:
  { title: string; hint?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-border bg-card p-4 shadow-sm", className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

export function Kpi({ title, value, sub, tone = "default" }:
  { title: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "default" | "good" | "warn" | "bad" }) {
  const toneCls = { default: "", good: "text-emerald-600 dark:text-emerald-400", warn: "text-amber-600 dark:text-amber-400",
    bad: "text-red-600 dark:text-red-400" }[tone]
  return (
    <div className="rounded-xl border border-border bg-card p-3.5 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", toneCls)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

const STATUS_TONE: Record<string, string> = {
  NEW: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  AGENT_WORKING: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  AGENT_PROPOSED: "bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200",
  RESOLVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  ESCALATED: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
  READY: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  BATCHED: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  RELEASED: "bg-emerald-600 text-white",
  DENIED: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  EXCEPTION: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  HELD: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
  OFFER_PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  DRAFT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  APPROVED: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  PENDING: "bg-violet-100 text-violet-800 dark:bg-violet-900/50 dark:text-violet-200",
  ACCEPTED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200",
  OVERRIDDEN: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
  INVALID: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200",
  RUNNING: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200",
  PAUSED: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  DAY_END: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200",
}

export function StatusPill({ value }: { value: string | null | undefined }) {
  const v = value ?? "—"
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
      STATUS_TONE[v] ?? "bg-muted text-muted-foreground")}>{label(v)}</span>
  )
}

export function StagePill({ stage }: { stage: string }) {
  const cls = { PRICING: "border-sky-300 text-sky-700 dark:text-sky-300", INTEGRITY: "border-orange-300 text-orange-700 dark:text-orange-300",
    PAYMENT: "border-emerald-300 text-emerald-700 dark:text-emerald-300" }[stage] ?? "border-border"
  return <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", cls)}>{stage}</span>
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> {what}…
    </div>
  )
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  )
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[11px]", className)}>{children}</code>
}

export function Btn({ children, onClick, disabled, variant = "primary", title, type = "button" }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; variant?: "primary" | "secondary" | "danger" | "ghost"
  title?: string; type?: "button" | "submit"
}) {
  const cls = {
    primary: "bg-[var(--brand-primary)] text-white hover:brightness-95",
    secondary: "border border-border bg-background hover:bg-muted",
    danger: "bg-red-600 text-white hover:bg-red-700",
    ghost: "hover:bg-muted",
  }[variant]
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled}
      className={cn("inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50", cls)}>
      {children}
    </button>
  )
}

export function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={cn("border-b border-border px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground", right ? "text-right" : "text-left")}>{children}</th>
}
export function Td({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cn("border-b border-border/60 px-2 py-1.5 align-top text-xs", right && "whitespace-nowrap text-right tabular-nums", className)}>{children}</td>
}
