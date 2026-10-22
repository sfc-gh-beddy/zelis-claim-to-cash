// Bounded evaluation over unresolved synthetic cases; failures stay in the denominator.
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CortexAgentClient, PatAuth } from '@snowflake/cortex-agent-sdk';
import { scoreProposal } from './scoring.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const runId = `EVAL-${randomUUID()}`;
const outDir = `${root}evals/out/${runId}`;
fs.mkdirSync(outDir, { recursive: true });
const literal = value => value == null ? 'NULL' : `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const variant = value => `parse_json(${literal(JSON.stringify(value))})`;
function sql(statement) {
  const stdout = execFileSync('snow', ['sql', '-c', 'zelis_c2c', '-q', statement, '--format', 'JSON'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
const perDecision = Number(process.env.EVAL_PER_DECISION ?? 2);
if (![1, 2, 3].includes(perDecision)) throw new Error('EVAL_PER_DECISION must be 1, 2 or 3');
const cases = sql(`select e.exception_id, e.claim_id, e.exception_type, e.stage, t.expected_decision, t.expected_allowed_amt
  from ZELIS_C2C.CORE.EXCEPTIONS e join ZELIS_C2C.OPS.GROUND_TRUTH t on e.claim_id=t.claim_id
  where e.status='NEW' and t.expected_exception_type=e.exception_type
    and not exists (select 1 from ZELIS_C2C.CORE.CLAIM_ADJUSTMENTS a where a.claim_id=e.claim_id and a.scenario_id='LIVE')
  qualify row_number() over(partition by e.exception_type,t.expected_decision order by e.exception_id)<=${perDecision}
  order by e.exception_type,t.expected_decision,e.exception_id`);
const agents = { PRICING: 'PRICING_EXCEPTION_AGENT', INTEGRITY: 'INTEGRITY_AGENT', PAYMENT: 'PAYMENT_OPS_AGENT' };
const snapshots = Object.fromEntries(Object.values(agents).map(name => [name, sql(`describe agent ZELIS_C2C.AI.${name}`)]));
fs.writeFileSync(`${outDir}/agent_config.json`, JSON.stringify(snapshots, null, 2));
sql(`insert into ZELIS_C2C.OPS.EVAL_RUNS(eval_run_id,label,agent_model,status,selected_cases,config_snapshot,methodology)
  select ${literal(runId)},'Unresolved synthetic cases; stratified by expected decision','claude-sonnet-5','RUNNING',${cases.length},
  ${variant(snapshots)},'Exact decision and cents; citation ID and verbatim quote only, semantic support NOT_REVIEWED; no retries'`);
const chunks = sql('select chunk_id,relative_path,chunk from ZELIS_C2C.AI.DOC_CHUNKS');
const client = new CortexAgentClient({ baseUrl: 'https://sfsenorthamerica-beddy.snowflakecomputing.com',
  auth: new PatAuth(fs.readFileSync(`${os.homedir()}/.snowflake/zelis_c2c_pat`, 'utf8').trim()), timeoutMs: 300000 });
const results = [];
function state(id) {
  return sql(`select status,version,latest_proposal_id,resolution from ZELIS_C2C.CORE.EXCEPTIONS where exception_id=${literal(id)}`);
}
async function runCase(item) {
  const correlation = `${runId}:${item.EXCEPTION_ID}`;
  const start = Date.now();
  const before = state(item.EXCEPTION_ID);
  const toolEvents = [];
  let response = null, error = null, agentRunId = null, proposal = null;
  sql(`insert into ZELIS_C2C.OPS.EVAL_ACTIVE(exception_id,correlation_id,eval_run_id)
    values(${literal(item.EXCEPTION_ID)},${literal(correlation)},${literal(runId)})`);
  try {
    const conv = await client.conversations.create({ thread: { origin_application: 'zelis_c2c_eval' },
      agent: { type: 'data', spec: { database: 'ZELIS_C2C', schema: 'AI', name: agents[item.STAGE] } } });
    const turn = await conv.send(`Work exception ${item.EXCEPTION_ID}. correlation_id: ${correlation}`);
    agentRunId = turn.id;
    // Never retry a failed turn or invalid proposal.
    for await (const event of turn.events()) {
      if (['response.tool_use', 'response.tool_result', 'error'].includes(event.event)) {
        toolEvents.push(event);
        fs.writeFileSync(`${outDir}/${item.EXCEPTION_ID}.tools.json`, JSON.stringify(toolEvents, null, 2));
      }
      if (event.event === 'error') error = String(event.message ?? 'agent error');
    }
    const result = await turn.result();
    response = { status: result.status, text: result.text, usage: result.usage };
    if (result.status !== 'completed') error ??= `agent status: ${result.status}`;
  } catch (caught) { error = caught.message; }
  try {
    proposal = sql(`select * from ZELIS_C2C.AI.PROPOSALS where exception_id=${literal(item.EXCEPTION_ID)}
      and agent_run_id=${literal(correlation)} and source='EVAL' order by created_at limit 1`)[0];
    if (proposal) { proposal.RAW = decode(proposal.RAW); proposal.CITATIONS = decode(proposal.CITATIONS); }
    const docs = sql(`select attachment_id,file_name,parsed_text from ZELIS_C2C.AI.DOC_EXTRACTS where claim_id=${literal(item.CLAIM_ID)}`);
    const sources = [...chunks.map(row => ({ ids: [row.CHUNK_ID, row.RELATIVE_PATH], text: row.CHUNK })),
      ...docs.map(row => ({ ids: [row.ATTACHMENT_ID, row.FILE_NAME], text: row.PARSED_TEXT }))];
    const score = scoreProposal(proposal, item, sources);
    const unchanged = JSON.stringify(before) === JSON.stringify(state(item.EXCEPTION_ID));
    const usage = response?.usage ?? {};
    const record = { ...item, agentRunId, response, proposal, score, error, stateUnchanged: unchanged, latencyMs: Date.now()-start };
    fs.writeFileSync(`${outDir}/${item.EXCEPTION_ID}.json`, JSON.stringify(record, null, 2));
    sql(`insert into ZELIS_C2C.OPS.EVAL_RESULTS(eval_run_id,exception_id,exception_type,agent_name,agent_run_id,
      expected_decision,actual_decision,expected_amount,actual_amount,decision_correct,amount_correct,citations_valid,schema_valid,
      failure_kind,latency_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,proposal_id,evidence_checks,raw_response,error,state_unchanged)
      select ${literal(runId)},${literal(item.EXCEPTION_ID)},${literal(item.EXCEPTION_TYPE)},${literal(agents[item.STAGE])},${literal(agentRunId)},
      ${literal(item.EXPECTED_DECISION)},${literal(proposal?.DECISION)},${literal(item.EXPECTED_ALLOWED_AMT)},${literal(proposal?.PROPOSED_ALLOWED_AMT)},
      ${score.decisionCorrect},${score.amountCorrect},${score.quotesMatched},${score.schemaValid},
      ${literal(!unchanged ? 'state_changed' : error ? 'runtime_error' : score.failureKind)},${record.latencyMs},
      ${literal(usage.input_tokens)},${literal(usage.output_tokens)},${literal(usage.cache_read_input_tokens)},${literal(usage.cache_write_input_tokens)},
      ${literal(proposal?.PROPOSAL_ID)},${variant(score.checks)},${variant(response)},${literal(error)},${unchanged}`);
    results.push(record);
    console.log(JSON.stringify({ exception: item.EXCEPTION_ID, decision: proposal?.DECISION, ...score, stateUnchanged: unchanged, error }));
  } finally {
    sql(`delete from ZELIS_C2C.OPS.EVAL_ACTIVE where correlation_id=${literal(correlation)}`);
  }
}
try {
  // Two independent cases at a time, bounded to keep warehouse/agent load modest.
  const queue = [...cases];
  const workerErrors = [];
  await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await runCase(item); }
      catch (error) {
        workerErrors.push({ exceptionId: item.EXCEPTION_ID, error: error.message });
        fs.writeFileSync(`${outDir}/persistence-errors.json`, JSON.stringify(workerErrors, null, 2));
      }
    }
  }));
  if (workerErrors.length) throw new Error(`${workerErrors.length} cases could not be persisted; inspect persistence-errors.json`);
  sql(`update ZELIS_C2C.OPS.EVAL_RUNS set status='DONE',finished_at=current_timestamp() where eval_run_id=${literal(runId)}`);
} catch (error) {
  sql(`update ZELIS_C2C.OPS.EVAL_RUNS set status='FAILED',finished_at=current_timestamp() where eval_run_id=${literal(runId)}`);
  throw error;
} finally {
  fs.writeFileSync(`${outDir}/summary.json`, JSON.stringify({ runId, selected: cases.length, recorded: results.length,
    decisionCorrect: results.filter(row=>row.score.decisionCorrect).length, amountCorrect: results.filter(row=>row.score.amountCorrect).length,
    stateUnchanged: results.every(row=>row.stateUnchanged), semanticSupport: 'NOT_REVIEWED' }, null, 2));
}
console.log(`Results: ${outDir}`);
