import { querySnowflake, querySnowflakeLongRunning } from "@/lib/snowflake"

export const DB = process.env.C2C_DB ?? "ZELIS_C2C"

/** Snowflake returns TIMESTAMP columns as Date objects; normalise at the boundary. */
export function toIso(val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null
  if (val instanceof Date) return val.toISOString()
  return String(val)
}

export function num(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null
  const n = Number(val)
  return Number.isFinite(n) ? n : null
}

/** VARIANT columns arrive as JSON strings or objects depending on the driver path. */
export function json<T = unknown>(val: unknown): T | null {
  if (val === null || val === undefined) return null
  if (typeof val === "string") {
    try { return JSON.parse(val) as T } catch { return val as unknown as T }
  }
  return val as T
}

export function rowsToObjects<T extends Record<string, unknown>>(rows: Record<string, any>[]): T[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) o[k.toLowerCase()] = v instanceof Date ? v.toISOString() : v
    return o as T
  })
}

export async function q<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, binds: unknown[] = []):
  Promise<T[]> {
  return rowsToObjects<T>(await querySnowflake(sql, binds.length ? { binds: binds as any } : {}))
}

/** CALL a stored procedure that returns VARIANT and parse its single value. */
export async function call<T = Record<string, unknown>>(sql: string, binds: unknown[] = [], longRunning = false):
  Promise<T> {
  const rows = longRunning
    ? await querySnowflakeLongRunning(sql, binds.length ? { binds: binds as any } : {})
    : await querySnowflake(sql, binds.length ? { binds: binds as any } : {})
  const first = rows[0] ?? {}
  return json<T>(Object.values(first)[0]) as T
}

export function errorResponse(e: unknown, fallback: string, status = 500) {
  console.error(new Date().toISOString(), fallback, e)
  return Response.json({ error: fallback }, { status })
}
