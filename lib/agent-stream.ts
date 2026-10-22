import type { AgentEvent } from "@/lib/agents"

/** EOF without a terminal event is a disconnect, not success. */
export async function consumeAgentStream(response: Response, onEvent: (event: AgentEvent) => void) {
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let terminal = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
        if (!data) continue
        const event = JSON.parse(data) as AgentEvent
        onEvent(event)
        if (event.type === "done") terminal = true
        if (event.type === "error") throw new Error(event.message)
      }
    }
    if (!terminal) throw new Error("Agent stream disconnected before completion")
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
