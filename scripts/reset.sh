#!/usr/bin/env bash
# Reset the simulation to day 1, minute 0. Keeps the AI extraction cache unless --cold is passed.
#   scripts/reset.sh --confirm          # warm reset (no OCR/extraction re-spend)
#   scripts/reset.sh --confirm --cold   # also clears AI.DOC_EXTRACTS so intake re-runs every AI function
set -euo pipefail
cd "$(dirname "$0")/.."
CONN="${SNOWFLAKE_CONNECTION:-zelis_c2c}"
KEEP=true
CONFIRMED=false
for arg in "$@"; do
  case "$arg" in
    --cold) KEEP=false ;;
    --confirm) CONFIRMED=true ;;
    *) printf 'Unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done
if [[ "$CONFIRMED" != true ]]; then
  printf '%s\n' 'Destructive reset refused. Pause the simulator, review active work, then pass --confirm (optionally --cold).' >&2
  exit 2
fi
snow sql -c "$CONN" -q "call ZELIS_C2C.OPS.SIM_CONTROL('PAUSE')" >/dev/null
snow sql -c "$CONN" --stdin <<'SQL'
execute immediate $$
declare active_work exception (-20001, 'Reset blocked: active evaluations or agents require inspection.');
begin
  if (exists (select 1 from ZELIS_C2C.OPS.EVAL_ACTIVE where expires_at > current_timestamp())
      or exists (select 1 from ZELIS_C2C.CORE.EXCEPTIONS where status = 'AGENT_WORKING')) then
    raise active_work;
  end if;
end;
$$;
SQL
snow sql -c "$CONN" -q "call ZELIS_C2C.OPS.SIM_RESET($KEEP, 'reset.sh')" >/dev/null
# Replay bindings refer to the previous simulation's state and must not survive a reset.
snow sql -c "$CONN" -q "delete from ZELIS_C2C.OPS.WORKFLOW_REQUESTS; delete from ZELIS_C2C.OPS.EVAL_ACTIVE; delete from ZELIS_C2C.CORE.BATCH_BUILD_WORK" >/dev/null
# REMOVE is not allowed inside procedures, so stage cleanup happens here.
snow sql -c "$CONN" -q "remove @ZELIS_C2C.RAW.INTAKE" >/dev/null
snow sql -c "$CONN" -q "remove @ZELIS_C2C.OPS.REMITTANCE" >/dev/null
snow sql -c "$CONN" -q "alter stage ZELIS_C2C.RAW.INTAKE refresh" >/dev/null
echo "reset complete (keep_ai_cache=$KEEP)"
