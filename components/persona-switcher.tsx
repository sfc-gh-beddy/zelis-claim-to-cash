"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { UserRound } from "lucide-react"
import type { Persona } from "@/lib/personas"

export function usePersona() {
  return useQuery<{ current: Persona; all: Persona[] }>({
    queryKey: ["persona"],
    queryFn: () => fetch("/api/persona").then((r) => r.json()),
    staleTime: Infinity,
  })
}

export function PersonaSwitcher() {
  const qc = useQueryClient()
  const { data } = usePersona()
  if (!data) return null
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--brand-nav-fg)]/80">
      <UserRound className="h-4 w-4" aria-hidden />
      <span className="hidden md:inline">Acting as</span>
      <select
        aria-label="Persona"
        className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-xs font-medium text-white outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
        value={data.current.id}
        onChange={async (e) => {
          await fetch("/api/persona", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ persona: e.target.value }) })
          await qc.invalidateQueries()
        }}
      >
        {data.all.map((p) => (
          <option key={p.id} value={p.id} className="text-slate-900">
            {p.person} · {p.label}
          </option>
        ))}
      </select>
    </label>
  )
}
