import { randomUUID } from "node:crypto"
import { AgentResponse, CortexAgentClient, OAuthAuth, PatAuth } from "@snowflake/cortex-agent-sdk"
import { CortexAgentClient as ApiCortexAgentClient } from "@snowflake/cortex-agent-sdk/api"
import { baseUrl, restAuth } from "@/lib/auth"
import { DB, q } from "@/lib/db"

/**
 * Cortex Agent SDK wrapper. Agents are saved objects (sql/06_agents.sql); the app picks one by exception stage.
 * Runs execute on Snowflake; browser disconnects can replay by run ID without launching a new turn.
 * Only the original follower persists telemetry; recovery observers are read-only.
 * Every run is recorded in AI.AGENT_RUNS with SDK-reported token usage, because agent turns do not appear in
 * AI Gateway traces.
 */
export const AGENT_FOR_STAGE: Record<string, string> = {
  PRICING: "PRICING_EXCEPTION_AGENT",
  INTEGRITY: "INTEGRITY_AGENT",
  PAYMENT: "PAYMENT_OPS_AGENT",
}

function auth() {
  // Callable so a rotated SPCS service token is picked up on every request attempt.
  const first = restAuth()
  return first.tokenType === "OAUTH" ? new OAuthAuth(() => restAuth().token) : new PatAuth(first.token)
}

let client: CortexAgentClient | null = null
let apiClient: ApiCortexAgentClient | null = null
function sdk() {
  client ??= new CortexAgentClient({ baseUrl: baseUrl(), auth: auth(), timeoutMs: 300_000 })
  return client
}
function api() {
  apiClient ??= new ApiCortexAgentClient({ baseUrl: baseUrl(), auth: auth(), timeoutMs: 300_000 })
  return apiClient
}

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "started"; runId: string }
  | { type: "tool_use"; name: string; input: unknown; id: string }
  | { type: "tool_result"; id: string; name?: string; status: string; preview?: string }
  | { type: "text"; text: string }
  | { type: "done"; runId: string; status: string; proposalId: string | null; usage: unknown; latencyMs: number }
  | { type: "error"; message: string }

interface StartArgs { exceptionId: string; claimId: string; stage: string; requestedBy: string; persona: string
  sweepId?: string | null }

function summarise(value: unknown, n = 400): string {
  const s = typeof value === "string" ? value : JSON.stringify(value)
  return s.length > n ? `${s.slice(0, n)}...` : s
}

/** Map raw SDK server-sent events to the small event vocabulary the UI renders. */
export function mapEvent(ev: any, toolNames: Map<string, string>): AgentEvent | null {
  switch (ev.event) {
    case "response.status":
      return ev.message ? { type: "status", message: String(ev.message) } : null
    case "response.thinking.delta":
      return null // Show tool activity, not the model's private reasoning.
    case "response.tool_use":
      toolNames.set(ev.tool_use_id, ev.name)
      return { type: "tool_use", name: ev.name, input: ev.input, id: ev.tool_use_id }
    case "response.tool_result": {
      const content = Array.isArray(ev.content) ? ev.content : []
      const preview = content.map((c: any) => c.json ?? c.text ?? "").map((x: unknown) => summarise(x, 300)).join(" ")
      return { type: "tool_result", id: ev.tool_use_id, name: toolNames.get(ev.tool_use_id) ?? ev.name,
        status: ev.status ?? "success", preview }
    }
    case "response.text.delta":
      return ev.text ? { type: "text", text: String(ev.text) } : null
    case "error":
      return { type: "error", message: String(ev.message ?? "agent error") }
    default:
      return null
  }
}

/** Start a run and yield UI events until it finishes. Persists telemetry at start and end. */
export async function* runAgentForException(args: StartArgs): AsyncGenerator<AgentEvent> {
  const agent = AGENT_FOR_STAGE[args.stage]
  if (!agent) { yield { type: "error", message: `no agent for stage ${args.stage}` }; return }
  const t0 = Date.now()
  const correlation = `${args.exceptionId}:${randomUUID()}`
  // A conditional UPDATE is atomic across service replicas and sweep/manual launches.
  const claimed = await q(`update ${DB}.CORE.EXCEPTIONS set status = 'AGENT_WORKING'
    where exception_id = ? and status = 'NEW'
      and not exists (select 1 from ${DB}.OPS.EVAL_ACTIVE where exception_id = ? and expires_at > current_timestamp())`,
    [args.exceptionId, args.exceptionId])
  if (Number(claimed[0]?.["number of rows updated"]) !== 1) {
    yield { type: "error", message: "Exception is already being worked, reserved, or no longer NEW. Refresh before retrying." }
    return
  }
  let submitted = false
  try {
  const conv = await sdk().conversations.create({
    thread: { origin_application: "zelis_c2c" },
    agent: { type: "data", spec: { database: DB, schema: "AI", name: agent } },
  })
  // If send fails ambiguously, leave the claim reserved for manual inspection rather than launch twice.
  submitted = true
  const turn = await conv.send(`Work exception ${args.exceptionId}. correlation_id: ${correlation}`)
  yield { type: "started", runId: turn.id }
  await q(`insert into ${DB}.AI.AGENT_RUNS (run_id, thread_id, exception_id, claim_id, agent_name, sweep_id,
            requested_by, persona, status, started_at, request_id)
           select ?, ?, ?, ?, ?, ?, ?, ?, 'STARTED', current_timestamp(), ?`,
    [turn.id, conv.id, args.exceptionId, args.claimId, agent, args.sweepId ?? null, args.requestedBy, args.persona, correlation])
  yield { type: "status", message: `${agent} started (run ${turn.id})` }
  yield* followRun(turn.id, args.exceptionId, t0, () => turn.events(), async () => turn.result())
  } catch (error) {
    if (!submitted) await q(`update ${DB}.CORE.EXCEPTIONS set status = 'NEW'
      where exception_id = ? and status = 'AGENT_WORKING'`, [args.exceptionId])
    throw error
  }
}

/** Re-attach to a run that is still executing (or finished) on the server. */
export async function* reattachRun(runId: string): AsyncGenerator<AgentEvent> {
  const rows = await q<{ exception_id: string; started_at: string; status: string }>(
    `select exception_id, started_at, status from ${DB}.AI.AGENT_RUNS where run_id = ?`, [runId])
  if (!rows[0]) { yield { type: "error", message: "unknown run" }; return }
  const t0 = Date.parse(rows[0].started_at) || Date.now()
  // Replay from the beginning so text, tools and usage are complete. Observers never overwrite telemetry.
  yield { type: "started", runId }
  yield* followRun(runId, rows[0].exception_id, t0, () => api().runs.stream(runId), null, false)
}

async function* followRun(runId: string, exceptionId: string, t0: number, events: () => AsyncIterable<any>,
  result: (() => Promise<any>) | null, persist = true): AsyncGenerator<AgentEvent> {
  const toolNames = new Map<string, string>()
  const tools: Array<{ name: string; status?: string }> = []
  let firstEventMs: number | null = null
  let answer = ""
  let toolErrors = 0
  let usage: any = null
  let status = "incomplete"
  let lastSeq: number | undefined
  try {
    for await (const ev of events()) {
      firstEventMs ??= Date.now() - t0
      if (typeof ev.sequence_number === "number") lastSeq = ev.sequence_number
      if (ev.event === "response") {
        status = ev.status ?? status
        usage = new AgentResponse(ev).usage
      }
      const mapped = mapEvent(ev, toolNames)
      if (!mapped) continue
      if (mapped.type === "tool_use") tools.push({ name: mapped.name })
      if (mapped.type === "tool_result" && mapped.status !== "success") toolErrors++
      if (mapped.type === "error") status = "failed"
      if (mapped.type === "text") answer += mapped.text
      yield mapped
    }
    if (result) {
      const res = await result()
      status = res.status ?? status
      usage = res.usage ?? usage
      answer = res.text || answer
    }
  } catch (e) {
    status = "failed"
    yield { type: "error", message: "Agent stream interrupted. Inspect or reconnect to the existing run before retrying." }
  }
  const latencyMs = Date.now() - t0
  const prop = await q<{ proposal_id: string }>(
    `select proposal_id from ${DB}.AI.PROPOSALS where exception_id = ? and source <> 'EVAL' and status = 'PENDING' and schema_valid
       and agent_run_id = (select request_id from ${DB}.AI.AGENT_RUNS where run_id = ?)
     order by created_at desc limit 1`, [exceptionId, runId])
  const proposalId = prop[0]?.proposal_id ?? null
  if (persist) await q(`update ${DB}.AI.AGENT_RUNS set status = ?, finished_at = current_timestamp(), latency_ms = ?, first_event_ms = ?,
            input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, tool_calls = parse_json(?),
            tool_errors = ?, answer = ?, proposal_id = ? where run_id = ?`,
    [status === "completed" ? "COMPLETED" : status.toUpperCase(), latencyMs, firstEventMs,
     usage?.input_tokens ?? null, usage?.output_tokens ?? null, usage?.cache_read_input_tokens ?? null,
     usage?.cache_write_input_tokens ?? null, JSON.stringify(tools), toolErrors, answer.slice(0, 8000), proposalId, runId])
  // If the agent finished without a valid proposal, put the exception back in the human queue.
  if (persist && !proposalId && status === "completed") {
    await q(`update ${DB}.CORE.EXCEPTIONS set status = 'NEW' where exception_id = ? and status = 'AGENT_WORKING'`, [exceptionId])
  }
  yield { type: "done", runId, status, proposalId, usage, latencyMs }
}

/** Drain a run to completion without a browser attached (queue sweep). */
export async function runToCompletion(args: StartArgs): Promise<{ proposalId: string | null; status: string }> {
  let last: { proposalId: string | null; status: string } = { proposalId: null, status: "failed" }
  for await (const ev of runAgentForException(args)) {
    if (ev.type === "done") last = { proposalId: ev.proposalId, status: ev.status }
  }
  return last
}

/** Server-sent events response for a run generator. */
export function sseResponse(gen: AsyncGenerator<AgentEvent>): Response {
  const encoder = new TextEncoder()
  let disconnected = false
  const stream = new ReadableStream({
    cancel() { disconnected = true },
    async start(controller) {
      const enqueue = (text: string) => { if (!disconnected) controller.enqueue(encoder.encode(text)) }
      const send = (ev: AgentEvent) => enqueue(`data: ${JSON.stringify(ev)}\n\n`)
      const keepAlive = setInterval(() => enqueue(": keep-alive\n\n"), 15_000)
      try {
        for await (const ev of gen) send(ev)
      } catch (e) {
        send({ type: "error", message: (e as Error).message })
      } finally {
        clearInterval(keepAlive)
        if (!disconnected) controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive",
      "X-Accel-Buffering": "no" },
  })
}
