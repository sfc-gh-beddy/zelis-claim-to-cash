import { call, DB, errorResponse, q } from "@/lib/db"
import { SimControlRequest } from "@/lib/contracts"
import { currentPersona, forbidden } from "@/lib/session"

export const dynamic = "force-dynamic"

/** Simulation control. RUN/PAUSE drive the 1-minute task; TICK advances synchronously (used for "fast-forward"). */
export async function POST(req: Request) {
  const persona = await currentPersona()
  const parsed = SimControlRequest.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return Response.json({ error: "invalid request", issues: parsed.error.issues }, { status: 400 })
  const { action, minutes } = parsed.data
  if (!persona.canControlSimulation) return forbidden(`${persona.label} cannot control the simulation`)
  try {
    if (action === "RESET") {
      return Response.json({ error: "Reset is maintenance-only. Pause the simulator and use scripts/reset.sh --confirm after reviewing active work." }, { status: 409 })
    }
    if (action !== "PAUSE") {
      const active = await q(`select exception_id from ${DB}.OPS.EVAL_ACTIVE where expires_at > current_timestamp()
        union all select exception_id from ${DB}.CORE.EXCEPTIONS where status = 'AGENT_WORKING'`)
      if (active.length) return Response.json({ error: "Pause active agent/evaluation work before advancing the simulation" }, { status: 409 })
    }
    if (action === "TICK") {
      return Response.json(await call(`call ${DB}.OPS.SIM_TICK(?)`, [minutes ?? 30], true))
    }
    return Response.json(await call(`call ${DB}.OPS.SIM_CONTROL(?)`, [action]))
  } catch (e) {
    return errorResponse(e, "simulation control failed")
  }
}
