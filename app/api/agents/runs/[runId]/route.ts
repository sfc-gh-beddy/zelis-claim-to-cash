import { reattachRun, sseResponse } from "@/lib/agents"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/** Re-attach to a durable agent run by id (e.g. after a page reload or a dropped connection). */
export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params
  if (!/^[0-9-]{6,64}$/.test(runId)) return Response.json({ error: "bad run id" }, { status: 400 })
  const after = new URL(req.url).searchParams.get("after")
  if (after !== null && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after)))) {
    return Response.json({ error: "bad event cursor" }, { status: 400 })
  }
  // Full replay avoids incomplete tool/text summaries and never launches a new turn.
  return sseResponse(reattachRun(runId))
}
