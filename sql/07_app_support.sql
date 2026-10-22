-- 07_app_support.sql — telemetry and bookkeeping tables written by the application.
use role ZELIS_C2C_ROLE;
use warehouse ZELIS_C2C_WH;
use database ZELIS_C2C;

-- One row per Cortex Agent run started by the app. Agent turns do not appear in AI Gateway traces, so the app
-- records the SDK-reported token usage here; CORTEX_AGENT_USAGE_HISTORY reconciles credits later (lagged).
create table if not exists AI.AGENT_RUNS (
  run_id string, thread_id string, exception_id string, claim_id string, agent_name string, sweep_id string,
  requested_by string, persona string, status string,  -- STARTED | COMPLETED | FAILED | CANCELLED
  started_at timestamp_ntz, finished_at timestamp_ntz, latency_ms int, first_event_ms int,
  input_tokens int, output_tokens int, cache_read_tokens int, cache_write_tokens int,
  tool_calls variant, tool_errors int, answer string, proposal_id string, error string, request_id string);

-- One row per direct AI Gateway call. conversation_id = claim_id joins to AGENT_TRACE_TABLE('SNOWFLAKE').
create table if not exists AI.GATEWAY_CALLS (
  call_id string, feature string, claim_id string, exception_id string, batch_id string, model string,
  conversation_id string, status string, http_status int, latency_ms int, input_tokens int, output_tokens int,
  validation variant, output string, error string, created_at timestamp_ntz default current_timestamp());

create table if not exists OPS.SWEEPS (
  sweep_id string, stage string, requested_by string, persona string, status string, planned int,
  started_at timestamp_ntz, finished_at timestamp_ntz, concurrency int);

-- Provider-facing documents generated from released batches (numbers come from SQL, prose from the model).
create table if not exists OPS.EOP_LETTERS (
  batch_id string, org_id string, claim_count int, amount number(18,2), letter string, validated boolean,
  validation variant, model string, call_id string, created_at timestamp_ntz default current_timestamp());
