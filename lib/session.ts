import { cookies } from "next/headers"
import { parsePersona, PERSONA_COOKIE, type Persona } from "@/lib/personas"

export async function currentPersona(): Promise<Persona> {
  const jar = await cookies()
  return parsePersona(jar.get(PERSONA_COOKIE)?.value)
}

export function forbidden(message: string) {
  return Response.json({ error: message, code: "FORBIDDEN" }, { status: 403 })
}
