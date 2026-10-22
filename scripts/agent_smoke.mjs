// Phase 3 check: run one exception per saved agent through the Cortex Agent SDK and print what happened.
// Usage: node scripts/agent_smoke.mjs [EXCEPTION_ID ...]
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { CortexAgentClient, PatAuth } from "@snowflake/cortex-agent-sdk";

for (const l of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2];
}
const AGENT_FOR = { PRICING: "PRICING_EXCEPTION_AGENT", INTEGRITY: "INTEGRITY_AGENT", PAYMENT: "PAYMENT_OPS_AGENT" };

function sql(q) {
  const out = execFileSync("snow", ["sql", "-c", "zelis_c2c", "-q", q, "--format", "json"], { encoding: "utf8" });
  return JSON.parse(out.slice(out.indexOf("[")));
}

let ids = process.argv.slice(2);
if (ids.length === 0) {
  ids = sql(`select any_value(exception_id) id from ZELIS_C2C.CORE.EXCEPTIONS where status = 'NEW'
             and exception_type in ('CONTRACT_CONFLICT','DUPLICATE_SUSPECT','BANK_CHANGE_HOLD') group by exception_type`)
    .map((r) => r.ID);
}
const exc = sql(`select exception_id, stage, exception_type from ZELIS_C2C.CORE.EXCEPTIONS
                 where exception_id in (${ids.map((i) => `'${i.replace(/'/g, "")}'`).join(",")})`);

const client = new CortexAgentClient({ baseUrl: process.env.SNOWFLAKE_ACCOUNT_URL, auth: new PatAuth(process.env.SNOWFLAKE_PAT) });

for (const e of exc) {
  const agent = AGENT_FOR[e.STAGE];
  const correlation = `smoke-${Date.now()}`;
  const t0 = Date.now();
  const conv = await client.conversations.create({
    thread: { origin_application: "zelis_c2c" },
    agent: { type: "data", spec: { database: "ZELIS_C2C", schema: "AI", name: agent } },
  });
  const turn = await conv.send(`Work exception ${e.EXCEPTION_ID}. correlation_id: ${correlation}`);
  const tools = [];
  let firstEventMs;
  for await (const ev of turn.events()) {
    firstEventMs ??= Date.now() - t0;
    if (ev.event === "response.tool_use") tools.push(ev.name ?? ev.tool_use?.name ?? "?");
    if (ev.event === "response.tool_result.status" && ev.status === "error") tools.push(`!err:${ev.tool_use_id}`);
  }
  const res = await turn.result();
  const ms = Date.now() - t0;
  const prop = sql(`select decision, proposed_allowed_amt, current_allowed_amt, confidence, schema_valid,
                    array_size(citations) n_cit, risk_flags, validation_errors
                    from ZELIS_C2C.AI.PROPOSALS where exception_id = '${e.EXCEPTION_ID}' order by created_at desc limit 1`)[0];
  console.log(JSON.stringify({ exception: e.EXCEPTION_ID, type: e.EXCEPTION_TYPE, agent, status: res.status, ms,
    first_event_ms: firstEventMs, tools, usage: res.usage,
    answer: res.text?.slice(0, 500), proposal: prop ?? null }, null, 1));
}
