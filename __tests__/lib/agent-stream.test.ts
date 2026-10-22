import { describe, expect, it, vi } from "vitest"
import { consumeAgentStream } from "../../lib/agent-stream"

function response(parts: string[]) {
  return new Response(new ReadableStream({ start(controller) {
    for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
    controller.close()
  } }))
}

describe("agent stream recovery boundary", () => {
  it("handles split frames and keepalive without dropping events", async () => {
    const onEvent = vi.fn()
    await consumeAgentStream(response([': keep-alive\n\n', 'data: {"type":"sta', 'rted","runId":"123456"}\n\n', 'data: {"type":"done","status":"completed"}\n\n']), onEvent)
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(["started", "done"])
  })
  it("does not call a disconnected stream complete", async () => {
    await expect(consumeAgentStream(response(['data: {"type":"status","message":"working"}\n\n']), vi.fn())).rejects.toThrow("disconnected")
  })
  it("surfaces backend errors rather than treating HTTP 200 as success", async () => {
    await expect(consumeAgentStream(response(['data: {"type":"error","message":"run failed"}\n\n']), vi.fn())).rejects.toThrow("run failed")
  })
  it("surfaces HTTP failures", async () => {
    await expect(consumeAgentStream(Response.json({ error: "reserved" }, { status: 409 }), vi.fn())).rejects.toThrow("reserved")
  })
})
