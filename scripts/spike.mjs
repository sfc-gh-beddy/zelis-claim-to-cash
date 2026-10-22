// Phase 0 spike: verify AI Gateway + Cortex Agent SDK with role-restricted PAT.
import fs from "node:fs";
import OpenAI from "openai";
import { CortexAgentClient, PatAuth } from "@snowflake/cortex-agent-sdk";
for (const l of fs.readFileSync(".env.local", "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2]; }
const base = process.env.SNOWFLAKE_ACCOUNT_URL;
const pat = process.env.SNOWFLAKE_PAT;

const gw = new OpenAI({ apiKey: pat, baseURL: `${base}/api/v2/aigateways/snowflake/v1`,
  defaultHeaders: { "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN", "snow-agent-name": "zelis-c2c-spike", "x-snowflake-ai-gateway-conversation-id": "spike-claim-0001" } });
let t = Date.now();
try {
  const r = await gw.chat.completions.create({ model: "openai-gpt-5.4-mini", max_completion_tokens: 40, messages: [{ role: "user", content: "Reply with exactly: gateway ok" }] });
  console.log("GATEWAY chat_completions OK", Date.now() - t, "ms ->", JSON.stringify(r.choices[0].message.content), r.usage);
} catch (e) { console.log("GATEWAY FAIL", e.status, e.message); }

const client = new CortexAgentClient({ baseUrl: base, auth: new PatAuth(pat) });
t = Date.now();
try {
  const conv = await client.conversations.create({ thread: { origin_application: "zelis_c2c_spike" },
    agent: { type: "inline", spec: { models: { orchestration: "claude-sonnet-5" }, instructions: { response: "Be terse." } } } });
  const turn = await conv.send("Reply with exactly: agent ok");
  const kinds = {};
  for await (const ev of turn.events()) kinds[ev.event] = (kinds[ev.event] ?? 0) + 1;
  const res = await turn.result();
  console.log("AGENT SDK OK", Date.now() - t, "ms ->", JSON.stringify(res.text), "status", res.status, "events", kinds, "turn", turn.id);
} catch (e) { console.log("AGENT FAIL", e.status ?? "", e.name, e.message?.slice(0, 400)); }
