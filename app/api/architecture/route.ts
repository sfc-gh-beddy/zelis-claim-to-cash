import { DB, errorResponse, q } from "@/lib/db"
import { runtimeMode } from "@/lib/auth"

export const dynamic = "force-dynamic"

async function show(sql: string): Promise<Record<string, unknown>[]> {
  try { return await q(sql) } catch (e) { return [{ error: (e as Error).message }] }
}

/** Live status of the Snowflake objects behind the app, for the Architecture page. */
export async function GET() {
  try {
    const [tasks, agents, search, gateways, views, procs, stages, whs] = await Promise.all([
      show(`show tasks in database ${DB}`),
      show(`show agents in schema ${DB}.AI`),
      show(`show cortex search services in database ${DB}`),
      show(`show ai gateways`),
      show(`show semantic views in database ${DB}`),
      q(`select procedure_schema || '.' || procedure_name name, created from ${DB}.INFORMATION_SCHEMA.PROCEDURES order by 1`),
      show(`show stages in database ${DB}`),
      show(`show warehouses like 'ZELIS_C2C_WH'`),
    ])
    const counts = await q(`select
        (select count(*) from ${DB}.RAW.CLAIMS) claims, (select count(*) from ${DB}.RAW.ATTACHMENTS) attachments,
        (select count(*) from ${DB}.AI.DOC_EXTRACTS) extracts, (select count(*) from ${DB}.AI.DOC_CHUNKS) chunks,
        (select count(*) from ${DB}.CORE.EXCEPTIONS) exceptions, (select count(*) from ${DB}.AI.PROPOSALS) proposals,
        (select count(*) from ${DB}.CORE.RULES where status = 'ACTIVE') active_rules,
        (select count(*) from ${DB}.OPS.AUDIT_LOG) audit_events, (select count(*) from ${DB}.CORE.PAYMENT_BATCHES) batches`)
    const [ctx] = await q(`select current_role() role, current_user() usr, current_warehouse() wh, current_account_name() account,
      current_region() region`)
    const pick = (rows: Record<string, unknown>[], keys: string[]) =>
      rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k] ?? r[k.toUpperCase()] ?? null])))
    return Response.json({
      runtime: { mode: runtimeMode(), ...ctx },
      tasks: pick(tasks, ["name", "state", "schedule", "warehouse", "error"]),
      agents: pick(agents, ["name", "comment", "created_on", "error"]),
      search: pick(search, ["name", "indexing_state", "serving_state", "source_data_num_rows", "error"]),
      gateways: pick(gateways, ["name", "base_url", "error"]),
      semanticViews: pick(views, ["name", "comment", "error"]),
      procedures: procs,
      stages: pick(stages, ["name", "schema_name", "directory_enabled", "error"]),
      warehouse: pick(whs, ["name", "state", "size", "auto_suspend", "error"]),
      counts: counts[0],
    })
  } catch (e) {
    return errorResponse(e, "architecture failed")
  }
}
