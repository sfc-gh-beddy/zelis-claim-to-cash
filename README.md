# Zelis Claim-to-Cash

A synthetic, end-to-end claims operations application for CTO and technical-team demonstrations. Deterministic Snowflake SQL calculates reimbursements; Cortex Agents investigate exceptions and submit proposals; people resolve exceptions, approve batches, and release simulated payments.

**Live app:** https://jhcmrsah-sfsenorthamerica-beddy.snowflakecomputing.app (last verified deployment: `VERSION$3`). The repository includes subsequent recovery hardening; that hardening has passed local tests but has not yet been deployed.

**Not a production payment system.** Same-day means ready for release, not guaranteed settlement. All claims, providers, contracts and rail transactions are synthetic. The persona switcher is a demonstration control, not user authorization.

## Architecture

- Next.js App Runtime application: `ZELIS_C2C.APP.ZELIS_CLAIM_TO_CASH`.
- Account `SFSENORTHAMERICA-BEDDY`; CLI connection `zelis_c2c`; owner role `ZELIS_C2C_ROLE`; XS warehouse `ZELIS_C2C_WH`.
- `RAW`: source/received claims, lines, attachments and intake stages.
- `CORE`: contract terms, fee schedules, deterministic pricing, integrity rules, claim/exception states and payment batches.
- `AI`: document extracts, contract/policy Search services, three saved agents, proposals and runtime telemetry.
- `OPS`: accelerated simulator, audit records, simulated rail ledger, remittance outbox, evaluations and ground truth.
- `APP.C2C_SV`: operational semantic view used by the agents' Analyst tools.

The simulator lands claims and staged PDFs. Intake runs OCR, classification and type-specific extraction. SQL prices claims using fixed-precision money and evaluates rule predicates. Clean claims become ready; exceptions enter a human work queue. Agents retrieve policy/contract evidence and call the same deterministic pricing engine in dry-run mode. No agent tool approves or releases payments.

The six pages are Command Center, Exceptions, Integrity, Payments, Governance and Architecture. Rules Studio is a deferred stretch feature, not an implemented coding-agent workflow.

## Authentication and boundaries

The deployed app uses the rotating App Runtime service OAuth token for SQL, Gateway and Agent SDK calls. All three have been tested in the deployed service. No developer PAT is mounted in the app. Local development uses a role-restricted PAT from ignored `.env.local`; test scripts read `~/.snowflake/zelis_c2c_pat`. Never commit or log these values.

Keep `lib/snowflake.ts`, `lib/sar-sdk/` and the workspace-root pins in `next.config.mjs` intact. Do not use the IDE's unrelated default Snowhouse connection for this application.

Personas are enforced by API and SQL checks but can be selected by any app user. The database owner can bypass app procedures. Production requires real identity/role mapping, narrower execution roles, protected audit storage and independent bank verification.

## Financial workflow

`sql/04_workflow.sql` defines implementation procedures. **Always apply `sql/09_atomic_workflows.sql` afterward** to install the public transactional wrappers.

`CORE.FINANCIAL_MUTATION` updates a shared mutex row, serializing public human financial mutations, and commits database effects together. Expected versions reject stale requests. Idempotency keys are bound to action and request payload. Corrected claims cannot replace an original already batched or released. Selected proposals must belong to the exception and be valid, pending, non-evaluation proposals.

Release commits a simulated ledger entry and `OPS.REMITTANCE_FILES` outbox record before exporting to `@OPS.REMITTANCE`. An export failure returns `PENDING_RETRY`; replay the identical release request/key to retry export without another financial release. A changed request requires a new key. The 835-style output is simplified, **not certified X12**.

The mutex does not cover simulator/reset operations or agent proposal submission. Pause the simulator and avoid concurrent maintenance while demonstrating payments. Failed database transactions roll back their internal audit writes too; not every denied request has durable audit coverage. Browser reset is disabled; the maintenance script requires `--confirm`, pauses the simulator and refuses active agent/evaluation work. Its checks are not an exclusive database maintenance lock.

## Local development

From this directory:

```bash
snow connection test -c zelis_c2c
npm ci
npm run dev
```

Use the existing ignored `.env.local` for local SQL/REST authentication. For a new developer, configure `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_ACCOUNT_URL`, `SNOWFLAKE_USER`, `SNOWFLAKE_PASSWORD`, `SNOWFLAKE_PAT`, `SNOWFLAKE_ROLE`, `SNOWFLAKE_WAREHOUSE`, and `C2C_DB` through local secret handling, not shell history or committed files. PAT expiry requires rotation outside the PAT-authenticated session.

Run `next dev` or `npm run start` for local preview, not `.next/standalone/server.js`. The standalone artifact is for deployment.

## Setup and maintenance

`scripts/bootstrap.sh` prints the installation order by default. `--apply-updates` applies only workflow, telemetry, evaluation and transaction SQL; it does not reset claims or regenerate data. Do not run it during agents, evals, payments or a simulation run.

Fresh installation is intentionally explicit: review `sql/00_bootstrap.sql` with an administrative connection first. The reference-data DDL and load files replace tables, so they are **not a safe migration path for an existing environment**. Then generate the corpus and apply numbered SQL in the documented order. `datagen/generate.py` defaults to 3 days x 1,200 claims with seed 20261026; PDF generation requires its Python dependencies. Loading paths in `01_load.sql` are relative to this directory.

The initial environment has 3,600 claims, 6,377 lines, 258 attachments and 67 contract/policy PDFs. The current simulation is paused with previously demonstrated releases preserved.

## Verification

```bash
npm test
npx tsc --noEmit
npm run build
node scripts/test-financial-concurrency.mjs
node scripts/deployed-smoke.mjs / /api/persona /api/architecture
```

The concurrency check creates and cleans a uniquely named $10 synthetic batch. It checks simultaneous duplicate release, one ledger transaction, export, replay and changed-request rejection. Audit events remain intentionally.

`sql/tests/01_pipeline_vs_truth.sql` compares deterministic pricing/routing to planted labels. Run it on a freshly processed, unmodified simulation for a baseline: human corrections and voids can intentionally differ from original labels. Initial verification matched all 3,336 clean claims to the cent and routed all 264 planted exceptions. Monetary extraction accuracy is not inferred from allowed reimbursement; caps make that inversion invalid.

## Evaluations

```bash
node evals/run_evals.mjs
```

Costs real inference credits. Default selects two unresolved, unadjusted cases per exception-type/expected-decision stratum and runs two workers. Model/schema failures are not silently retried. Config snapshots and individual outputs are written under ignored `evals/out`; results are stored in `OPS.EVAL_RUNS` and `OPS.EVAL_RESULTS`.

Correlation-scoped registrations route evaluation proposals to `source/status=EVAL`, separate from the live review queue. The harness compares exception state before/after. Do not reset, run other evaluations, or mutate selected claims concurrently.

Scores report decision agreement, exact-cent amounts, schema validity and durable-source/verbatim-quote matches. **Source/quote matching does not prove the evidence supports the decision. Semantic support is NOT_REVIEWED.** Temporary Search IDs and field-name-only references count as unverified. DOC_REVIEW has no matched ground-truth stratum in this run. Results describe this small synthetic sample, not real-world clinical/payment accuracy.

## Evaluation baseline (October 22, 2026)

Run `EVAL-f6acd26d-45b4-4aa0-8ff4-44b5f41beb7b` recorded all 28 selected cases. Exception state was unchanged in every case. No semantic-support review was performed.

| Exception type | Cases | Decision match | Amount exact | All source/quotes matched |
|---|---:|---:|---:|---:|
| Bank change | 4 | 3 | 4 | 4 |
| Contract conflict | 4 | 4 | 4 | 1 |
| Duplicate/corrected | 4 | 4 | 4 | 4 |
| E/M level | 4 | 4 | 4 | 0 |
| Modifier | 4 | 4 | 4 | 0 |
| Out-of-network | 4 | 4 | 4 | 0 |
| Stop-loss | 2 | 1 | 1 | 0 |
| Unbundling | 2 | 2 | 2 | 2 |

One bank case conservatively held instead of the planted release-after-verification label. One stop-loss case produced no registered proposal. Citation failures include transient Search IDs, section titles and field references that cannot be resolved by the strict document-ID scorer. These are retained as failures rather than relabeled as verified evidence.

## Costs and observability

`AI.AGENT_RUNS` stores SDK latency, tokens and tool outcomes. `AI.GATEWAY_CALLS` stores direct triage/EOP calls. Gateway trace headers attribute direct calls to `zelis-c2c/<feature>` and a claim/batch conversation ID. Saved-agent turns are not Gateway traces.

Governance displays live token usage and lagged ACCOUNT_USAGE credits. Gateway totals are explicitly account-wide, not all attributable to this app. Search/App Runtime storage and compute are not fully reconciled in the page. There is no verified dollar-per-proposal or typical-demo total yet. Gateway payload capture remains off because the gateway is account-wide.

## Deployment

```bash
snow app validate --project . --connection zelis_c2c
snow app deploy --project . --connection zelis_c2c --verbose
```

`app.yml` v2 is the deployment source of truth. It targets the existing application in `ZELIS_C2C.APP` with `ZELIS_C2C_WH`. Deployment applies settings declaratively, potentially resetting out-of-band settings. Secrets, generated corpus, evaluation output and SQL are excluded from the app bundle. Existing app access is unchanged by this handoff; do not grant the owner role to demo viewers.

## Operational runbook

1. Open Architecture: verify service identity, active Search services and saved agents.
2. Keep the simulator paused when evaluating or testing financial mutations.
3. Investigate NEW exceptions; inspect documents, dry-run trace and cited evidence before resolving.
4. Switch to an eligible payment approver distinct from the resolver. Respect batch/claim limits and segregation of duties.
5. Release only after reviewing batch totals. Confirm ledger and remittance; retry export with the same request if needed.
6. Agent streams automatically reconnect up to three times to the same run ID and can resume after a same-tab reload. Replays do not overwrite the original follower's telemetry. Atomic conditional updates reserve NEW exceptions across sweep/manual launches. An ambiguous submission stays reserved for operator inspection; never blindly clear AGENT_WORKING. Sweep restart recovery remains manual.
7. `scripts/reset.sh --confirm` is destructive to simulation workflow state. Run only during exclusive maintenance with no other clients writing; preserve eval outputs/audit evidence first. It clears stale request bindings and batch work rows after resetting. Warm reset retains extraction cache; `--cold` re-spends on AI. Reset is not a production recovery mechanism. Clear browser session storage after a reset to discard old request keys.
8. Suspend the simulator when done. Running App Runtime and Search resources can continue to consume credits even when the simulator is paused.

## 15-minute CTO demo

- **0-2 min, Command Center:** explain clean-claim flow and readiness versus settlement; synthetic corpus and deterministic money.
- **2-6 min, Exceptions:** open a modifier or contract exception, show PDF and pricing trace, run the saved agent, inspect its proposal and citations. Explain that the agent cannot resolve or release.
- **6-8 min, Integrity:** show a duplicate/corrected-claim or E/M case. Review evidence and the human disposition; do not frame a coding flag as fraud proof.
- **8-11 min, Payments:** select an appropriate persona, review a draft batch, demonstrate limits/segregation of duties, approve and release through simulated rails. Preview the balanced remittance and explain replay/outbox handling.
- **11-13 min, Governance:** show tokens, latency, reviewer agreement, evaluation failures and lagged credits. Distinguish quote matches from semantic citation support.
- **13-15 min, Architecture:** show actual objects and service-token execution. Close with the production work required: identity, isolation, bank verification, certified rails/remittance, durable workers, independent extraction validation and broader evals.

## Remaining limitations

- Synthetic rules, contracts, coding evidence and payment rails; no real settlement or bank-account verification.
- Persona switching is not production authorization. Agents share a trusted demo owner role; tool restrictions are not a database least-privilege boundary.
- Sweep work lives in the app process; interrupted work needs inspection/recovery. Same-tab reconnection is implemented; process-crash recovery, atomic coordination with eval registration/reset, and multi-tab payment replay coordination remain open.
- Extraction confidence gates are not independent verification of document amounts.
- Citation semantics need review; source identifiers are inconsistent in some agent outputs.
- One-minute warehouse-backed simulator task, not a stream-triggered pipeline graph.
- Rules Studio managed coding agent remains deferred.
- Runtime dependency audit: zero known vulnerabilities after compatible lockfile updates on October 22, 2026. Two moderate development-only Vitest advisories remain; do not expose a Vitest development/mock server.

## Repository verification (October 22, 2026)

The recovery hardening passes 90 unit tests, standalone TypeScript checking and a production build. New tests cover conditional agent reservations, ambiguous submission, read-only reconnect, split SSE frames, premature EOF and maintenance guards. Payment request payloads are retained in same-tab session storage for retry after unknown outcomes or pending remittance export. Evaluation runs now retain tool-use/result events (not private reasoning) and wait for every worker before marking a persistence failure. No additional live evaluation or financial release was run for these changes.

The original plan is not fully complete: managed coding-agent Rules Studio, semantic citation-support review, fully attributed demo costs, viewer-role provisioning and production security/recovery remain outstanding. The current synthetic evaluation baseline above has not been rescored or relabeled.
