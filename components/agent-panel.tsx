"use client"

import { useEffect, useRef, useState } from "react"
import { consumeAgentStream } from "@/lib/agent-stream"
import { Bot, CheckCircle2, FileText, Loader2, Search, ShieldAlert, Sparkles, Wrench } from "lucide-react"
import type { AgentEvent } from "@/lib/agents"
import { cn } from "@/lib/utils"

const TOOL_LABEL: Record<string, string> = {
  get_exception_context: "Read claim, contract, documents",
  reprice_decision: "Dry-run pricing engine",
  contract_search: "Search contract",
  policy_search: "Search policy",
  submit_proposal: "Submit proposal for review",
  claims_analyst: "Cortex Analyst query",
}
const TOOL_ICON: Record<string, typeof Wrench> = {
  get_exception_context: FileText, reprice_decision: Sparkles, contract_search: Search, policy_search: Search,
  submit_proposal: CheckCircle2, claims_analyst: Search,
}

type Step = { id: string; name: string; input: unknown; status?: string; preview?: string }

/** Streams one Cortex Agent run (SSE from /api/agents/run) and renders tool calls as they happen. */
export function AgentPanel({ exceptionId, disabled, onDone }:
  { exceptionId: string; disabled?: boolean; onDone: () => void }) {
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<Step[]>([])
  const [text, setText] = useState("")
  const [status, setStatus] = useState<string | null>(null)
  const [done, setDone] = useState<Extract<AgentEvent, { type: "done" }> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const started = useRef<number>(0)

  const active = useRef(false)
  const runId = useRef<string | null>(null)
  const storageKey = `c2c-agent:${exceptionId}`

  useEffect(() => {
    const saved = sessionStorage.getItem(storageKey)
    if (saved && /^[0-9-]{6,64}$/.test(saved)) {
      runId.current = saved
      void run(true)
    }
    // Resume only when this exception is opened; callback identity must not restart a stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exceptionId])

  async function run(resume = false) {
    if (active.current) return
    active.current = true
    setRunning(true); setSteps([]); setText(""); setDone(null); setError(null)
    if (!resume) runId.current = null
    started.current = Date.now()
    const receive = (ev: AgentEvent) => {
      if (ev.type === "started") {
        runId.current = ev.runId
        sessionStorage.setItem(storageKey, ev.runId)
      } else if (ev.type === "status") setStatus(ev.message)
      else if (ev.type === "tool_use") setSteps(s => [...s.filter(x => x.id !== ev.id), { id: ev.id, name: ev.name, input: ev.input }])
      else if (ev.type === "tool_result") setSteps(s => s.map(x => x.id === ev.id ? { ...x, status: ev.status, preview: ev.preview } : x))
      else if (ev.type === "text") setText(t => t + ev.text)
      else if (ev.type === "done") {
        setDone(ev)
        if (ev.status === "completed") {
          sessionStorage.removeItem(storageKey)
          runId.current = null
        } else setError(`Run ${ev.status}; inspect before launching another agent.`)
      }
    }
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          setStatus(runId.current ? "Reconnecting to existing run..." : "Starting agent...")
          setSteps([]); setText("")
          const response = runId.current
            ? await fetch(`/api/agents/runs/${runId.current}`)
            : await fetch("/api/agents/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ exceptionId }) })
          await consumeAgentStream(response, receive)
          break
        } catch (error) {
          if (!runId.current || attempt === 2) throw error
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)))
        }
      }
    } catch (error) {
      setError((error as Error).message)
    } finally {
      active.current = false
      setRunning(false); setStatus(null); onDone()
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-[var(--brand-primary)]" />
          <h2 className="text-sm font-semibold">Cortex Agent</h2>
          <span className="text-[11px] text-muted-foreground">propose-only tools · cannot resolve or release</span>
        </div>
        <button onClick={() => run(!!runId.current)} disabled={running || (disabled && !runId.current)}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
          {running ? `Working… ${Math.round((Date.now() - started.current) / 1000)}s` : runId.current ? "Reconnect to run" : "Ask agent to propose"}
        </button>
      </div>
      {status && <p className="mt-2 text-xs text-muted-foreground">{status}</p>}
      {steps.length > 0 && (
        <ol className="mt-3 space-y-1.5">
          {steps.map((s, i) => {
            const Icon = TOOL_ICON[s.name] ?? Wrench
            return (
              <li key={s.id} className="rounded-md border border-border/70 bg-muted/30 px-2.5 py-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-4 text-right text-muted-foreground">{i + 1}</span>
                  <Icon className="h-3.5 w-3.5" />
                  <span className="font-medium">{TOOL_LABEL[s.name] ?? s.name}</span>
                  <code className="text-[10px] text-muted-foreground">{s.name}</code>
                  <span className={cn("ml-auto text-[10px]", s.status === "success" ? "text-emerald-600" : s.status ? "text-red-600" : "text-muted-foreground")}>
                    {s.status ?? "running…"}</span>
                </div>
                {s.input !== null && typeof s.input === "object" && Object.keys(s.input as object).length > 0 ? (
                  <div className="mt-1 truncate pl-6 font-mono text-[10px] text-muted-foreground">{JSON.stringify(s.input)}</div>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
      {text && <div className="mt-3 whitespace-pre-wrap rounded-md bg-muted/40 p-2.5 text-xs leading-relaxed">{text}</div>}
      {error && <p className="mt-2 flex items-center gap-1 text-xs text-red-600"><ShieldAlert className="h-3.5 w-3.5" />{error}</p>}
      {done && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Run <code>{done.runId}</code> · {(done.latencyMs / 1000).toFixed(1)} s · {done.proposalId ? "proposal recorded" : "no valid proposal (left for a human)"}
          {done.usage ? ` · tokens in ${(done.usage as any).input_tokens + ((done.usage as any).cache_read_input_tokens ?? 0) + ((done.usage as any).cache_write_input_tokens ?? 0)} (cache read ${(done.usage as any).cache_read_input_tokens ?? 0}) / out ${(done.usage as any).output_tokens}` : ""}
        </p>
      )}
    </div>
  )
}
