import { cookies } from "next/headers"
import { PERSONAS, PERSONA_COOKIE, parsePersona } from "@/lib/personas"

export const dynamic = "force-dynamic"

export async function GET() {
  const jar = await cookies()
  return Response.json({ current: parsePersona(jar.get(PERSONA_COOKIE)?.value), all: Object.values(PERSONAS) })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  if (!body?.persona || !(body.persona in PERSONAS)) return Response.json({ error: "unknown persona" }, { status: 400 })
  const jar = await cookies()
  jar.set(PERSONA_COOKIE, body.persona, { httpOnly: true, sameSite: "lax", secure: true, path: "/" })
  return Response.json({ current: PERSONAS[body.persona as keyof typeof PERSONAS] })
}
