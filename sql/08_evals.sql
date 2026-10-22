-- Additive evaluation storage. No live claims, payments or decisions are reset.
use role ZELIS_C2C_ROLE;
use database ZELIS_C2C;
use warehouse ZELIS_C2C_WH;
create table if not exists OPS.EVAL_ACTIVE (
  exception_id string, correlation_id string, eval_run_id string,
  expires_at timestamp_ntz default dateadd(hour, 1, current_timestamp()));
create table if not exists OPS.EVAL_RUNS (
  eval_run_id string, label string, agent_model string, status string,
  started_at timestamp_ntz default current_timestamp(), finished_at timestamp_ntz,
  selected_cases int, config_snapshot variant, methodology string);
create table if not exists OPS.EVAL_RESULTS (
  eval_run_id string, exception_id string, exception_type string, agent_name string, agent_run_id string,
  expected_decision string, actual_decision string, expected_amount number(18,2), actual_amount number(18,2),
  decision_correct boolean, amount_correct boolean, citations_valid boolean, schema_valid boolean,
  failure_kind string, latency_ms number, input_tokens number, output_tokens number,
  cache_read_tokens number, cache_write_tokens number, proposal_id string, evidence_checks variant,
  raw_response variant, error string, state_unchanged boolean, created_at timestamp_ntz default current_timestamp());
