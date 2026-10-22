#!/usr/bin/env bash
# Existing environments: additive schema support + reviewed procedure updates only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONNECTION="${SNOWFLAKE_CONNECTION:-zelis_c2c}"
case "${1:---help}" in
  --apply-updates)
    snow connection test -c "$CONNECTION"
    for file in 08_evals.sql 04_workflow.sql 07_app_support.sql 09_atomic_workflows.sql; do
      snow sql -c "$CONNECTION" -f "$ROOT/sql/$file"
    done
    ;;
  --help)
    printf '%s\n' 'Fresh install (review destructive reference-data replacement first):' \
      '1. sql/00_bootstrap.sql with an authorized administrative connection.' \
      '2. Generate datagen/out using datagen/generate.py from the project root.' \
      '3. sql/01_schema.sql, sql/01_load.sql, sql/02_engine.sql, sql/03_pipeline.sql.' \
      '4. sql/08_evals.sql, sql/04_workflow.sql, sql/05_ai_layer.sql, sql/06_agents.sql.' \
      '5. sql/07_app_support.sql, sql/09_atomic_workflows.sql.' \
      '6. Verify models, gateway logging, Search readiness and app deployment.' \
      'Existing environment: --apply-updates updates procedures/support tables only.' \
      'Pause simulation and stop active agents/evals/payments before any updates.'
    ;;
  *) printf '%s\n' 'Usage: bootstrap.sh [--help|--apply-updates]' >&2; exit 2 ;;
esac
