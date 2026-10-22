import { getServiceToken, getSnowflakeBaseUrl } from "@/lib/snowflake"

/**
 * Auth for Snowflake REST endpoints (Cortex Agents, AI Gateway).
 *  - In App Runtime (SPCS): the rotating service token, sent as OAUTH. Requests run as the app's owner role.
 *  - Local dev: a role-restricted programmatic access token from SNOWFLAKE_PAT (.env.local).
 * The token is read on every call so rotation is picked up without a restart.
 */
export function restAuth(): { token: string; tokenType: "OAUTH" | "PROGRAMMATIC_ACCESS_TOKEN" } {
  const service = getServiceToken()
  if (service) return { token: service, tokenType: "OAUTH" }
  const pat = process.env.SNOWFLAKE_PAT
  if (pat) return { token: pat, tokenType: "PROGRAMMATIC_ACCESS_TOKEN" }
  throw new Error("No REST credential: not running in App Runtime and SNOWFLAKE_PAT is not set")
}

export function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const { token, tokenType } = restAuth()
  return { Authorization: `Bearer ${token}`, "X-Snowflake-Authorization-Token-Type": tokenType, ...extra }
}

export function baseUrl(): string {
  const url = getSnowflakeBaseUrl()
  if (!url) throw new Error("Cannot resolve Snowflake base URL (set SNOWFLAKE_ACCOUNT_URL locally)")
  return url.replace(/\/$/, "")
}

export function runtimeMode(): "app-runtime" | "local" {
  return getServiceToken() ? "app-runtime" : "local"
}
