-- 04_workflow.sql — personas, decision catalog, proposals, exception resolution, payment batches, rails,
-- remittance, audit, reset. Every state change goes through a procedure here; the app never writes tables.
use role ZELIS_C2C_ROLE;
use warehouse ZELIS_C2C_WH;
use database ZELIS_C2C;

-- ---------------------------------------------------------------- personas (app-level simulation of roles)
create or replace table OPS.PERSONAS (
  persona_id string primary key, display_name string, person string, stages array, batch_limit number(18,2),
  claim_limit number(18,2), can_create_batches boolean, can_release boolean);
insert into OPS.PERSONAS
  select 'PRICING_ANALYST', 'Pricing Analyst', 'Priya Shah', ['PRICING'], 0, 0, false, false
  union all select 'INTEGRITY_REVIEWER', 'Integrity Reviewer', 'Marcus Lee', ['INTEGRITY'], 0, 0, false, false
  union all select 'PAYMENT_APPROVER', 'Payment Approver', 'Dana Ortiz', [], 250000, 50000, true, true
  union all select 'OPS_LEAD', 'Payments Operations Lead', 'Sam Rivera', ['PRICING', 'INTEGRITY', 'PAYMENT'], 99999999, 99999999, true, true;

-- ---------------------------------------------------------------- audit + idempotency
create table if not exists OPS.AUDIT_LOG (
  event_id string default uuid_string(), event_ts timestamp_ntz default current_timestamp(), sim_ts timestamp_ntz,
  actor string, persona string, action string, entity_type string, entity_id string, detail variant,
  idempotency_key string);
create table if not exists OPS.IDEMPOTENCY (idem_key string, action string, result variant,
  created_at timestamp_ntz default current_timestamp());

-- ---------------------------------------------------------------- decision catalog
create or replace table CORE.DECISIONS (
  exception_type string, decision string, label string, outcome string, needs_value boolean, description string);
insert into CORE.DECISIONS values
  ('MODIFIER_REVIEW', 'APPLY_MODIFIER_50', 'Bilateral: add modifier 50', 'RESOLVED', false, 'Re-price one unit at 150% per modifier policy'),
  ('MODIFIER_REVIEW', 'PRICE_AS_BILLED', 'Price as billed', 'RESOLVED', false, 'Documentation supports units as billed'),
  ('CONTRACT_CONFLICT', 'APPLY_EXHIBIT_RATE', 'Apply Exhibit A rate', 'RESOLVED', false, 'Exhibit controls per order of precedence'),
  ('CONTRACT_CONFLICT', 'APPLY_INVOICE_PLUS', 'Apply invoice + markup (body)', 'RESOLVED', false, 'Body controls per order of precedence'),
  ('DOC_REVIEW', 'ENTER_INVOICE_COST', 'Enter verified invoice cost', 'RESOLVED', true, 'Human keys the invoice total from the document'),
  ('STOP_LOSS_REVIEW', 'APPLY_STOP_LOSS', 'Apply stop-loss on eligible charges', 'RESOLVED', false, 'Uses extracted non-covered total unless a verified value is entered'),
  ('OON_REVIEW', 'PRICE_AT_OON_POLICY', 'Price at OON policy', 'RESOLVED', false, 'Billed between review and negotiation thresholds'),
  ('OON_REVIEW', 'NEGOTIATE_OFFER', 'Send offer at OON policy amount', 'RESOLVED', false, 'Above negotiation threshold; hold for acceptance'),
  ('DUPLICATE_SUSPECT', 'DENY_DUPLICATE', 'Deny as duplicate', 'RESOLVED', false, 'Exact duplicate (frequency 1)'),
  ('DUPLICATE_SUSPECT', 'REPLACE_ORIGINAL', 'Corrected claim replaces original', 'RESOLVED', false, 'Frequency 7: void original, pay corrected'),
  ('UNBUNDLING', 'DENY_COMPONENT_LINE', 'Deny component line', 'RESOLVED', false, 'Included in comprehensive procedure'),
  ('UNBUNDLING', 'ALLOW_AS_BILLED', 'Allow as billed', 'RESOLVED', false, 'Documentation supports a distinct procedure'),
  ('EM_LEVEL_REVIEW', 'DOWNCODE_TO_99213', 'Recode to 99213', 'RESOLVED', false, 'Note documents low-complexity decision making'),
  ('EM_LEVEL_REVIEW', 'UPHOLD_LEVEL', 'Uphold level 5', 'RESOLVED', false, 'Note supports high-complexity decision making'),
  ('BANK_CHANGE_HOLD', 'RELEASE_AFTER_VERIFICATION', 'Verified: release payment', 'RESOLVED', false, 'Call-back to number on file confirmed; name and TIN match'),
  ('BANK_CHANGE_HOLD', 'HOLD_FRAUD_REVIEW', 'Keep hold: fraud review', 'ESCALATED', false, 'Red flags present; do not release');

-- Maps a decision to engine adjustments. Pure function of its inputs (no table reads).
create or replace function CORE.DECISION_TO_ADJ(P_DECISION string, P_LINE_NO int, P_DUP_OF string, P_VALUE number(18,2))
returns array as
$$
  case P_DECISION
    when 'APPLY_MODIFIER_50'   then [{'line_no': P_LINE_NO, 'action': 'ADD_MODIFIER', 'value_str': '50'}]
    when 'APPLY_EXHIBIT_RATE'  then [{'line_no': P_LINE_NO, 'action': 'CARVEOUT_SOURCE', 'value_str': 'EXHIBIT A'}]
    when 'APPLY_INVOICE_PLUS'  then [{'line_no': P_LINE_NO, 'action': 'CARVEOUT_SOURCE', 'value_str': 'BODY 4.2'}]
    when 'ENTER_INVOICE_COST'  then [{'line_no': P_LINE_NO, 'action': 'INVOICE_COST', 'value_num': P_VALUE}]
    when 'APPLY_STOP_LOSS'     then iff(P_VALUE is null, [], [{'line_no': 0, 'action': 'STOP_LOSS_NONCOVERED', 'value_num': P_VALUE}])
    when 'DENY_DUPLICATE'      then [{'line_no': 0, 'action': 'DENY_CLAIM'}]
    when 'REPLACE_ORIGINAL'    then [{'line_no': 0, 'action': 'REPLACES_CLAIM', 'value_str': P_DUP_OF}]
    when 'DENY_COMPONENT_LINE' then [{'line_no': P_LINE_NO, 'action': 'DENY_LINE'}]
    when 'DOWNCODE_TO_99213'   then [{'line_no': P_LINE_NO, 'action': 'RECODE', 'value_str': '99213'}]
    when 'HOLD_FRAUD_REVIEW'   then [{'line_no': 0, 'action': 'PAYMENT_HOLD'}]
    else []
  end
$$;

-- ---------------------------------------------------------------- proposals (agents write here, nothing else)
create table if not exists AI.PROPOSALS (
  proposal_id string primary key, exception_id string not null, claim_id string, agent_name string, source string,
  agent_run_id string, thread_id string, decision string, adjustments variant, dry_run variant,
  proposed_allowed_amt number(18,2), current_allowed_amt number(18,2), rationale string, citations variant,
  confidence float, risk_flags variant, schema_valid boolean, validation_errors variant, raw variant,
  model string, usage variant, latency_ms int, status string, created_at timestamp_ntz default current_timestamp());

-- Correlation-scoped evaluation registrations never divert an unrelated live proposal.
create table if not exists OPS.EVAL_ACTIVE (
  exception_id string, correlation_id string, eval_run_id string,
  expires_at timestamp_ntz default dateadd(hour, 1, current_timestamp()));

create or replace procedure AI.SUBMIT_PROPOSAL(P_EXCEPTION_ID string, P_PROPOSAL variant, P_AGENT string, P_RUN_ID string)
returns variant language sql execute as owner as
$$
declare
  pid string default 'PRP-' || uuid_string();
  exc_type string; claim string; line_no int; status string; dup_of string; decision string; errs array default [];
  adj array; dry variant; cur number(18,2); n int; is_eval boolean default false;
begin
  select exception_type, claim_id, coalesce(line_no, 1), status into :exc_type, :claim, :line_no, :status
    from CORE.EXCEPTIONS where exception_id = :P_EXCEPTION_ID;
  if (claim is null) then return object_construct('ok', false, 'error', 'unknown exception_id'); end if;
  if (status in ('RESOLVED', 'ESCALATED')) then return object_construct('ok', false, 'error', 'exception already closed'); end if;
  is_eval := (select count(*) > 0 from OPS.EVAL_ACTIVE where exception_id = :P_EXCEPTION_ID
    and correlation_id = :P_RUN_ID and expires_at > current_timestamp());
  if (not is_eval and exists (select 1 from OPS.EVAL_ACTIVE where exception_id = :P_EXCEPTION_ID
      and expires_at > current_timestamp())) then
    return object_construct('ok', false, 'error', 'exception reserved for evaluation');
  end if;

  decision := upper(P_PROPOSAL:decision::string);
  n := (select count(*) from CORE.DECISIONS where exception_type = :exc_type and decision = :decision);
  if (n = 0) then errs := array_append(errs, 'decision not allowed for ' || exc_type); end if;
  if (P_PROPOSAL:rationale is null or length(P_PROPOSAL:rationale::string) < 20) then errs := array_append(errs, 'rationale missing'); end if;
  if (not coalesce(is_array(P_PROPOSAL:citations), false) or coalesce(array_size(P_PROPOSAL:citations), 0) = 0) then
    errs := array_append(errs, 'citations must be a nonempty array');
  elseif (exists (select 1 from table(flatten(input => :P_PROPOSAL:citations))
      where not is_object(value) or coalesce(length(value:source::string), 0) = 0
        or coalesce(length(value:ref::string), 0) = 0 or coalesce(length(value:quote::string), 0) = 0)) then
    errs := array_append(errs, 'each citation requires source, ref and quote');
  end if;
  if (try_to_double(P_PROPOSAL:confidence::string) is null or P_PROPOSAL:confidence::float not between 0 and 1) then
    errs := array_append(errs, 'confidence must be 0..1'); end if;

  dup_of := (select first_claim_id from CORE.V_DUPLICATES where claim_id = :claim);
  cur := (select allowed_amt from CORE.CLAIM_STATE where claim_id = :claim);
  if (array_size(errs) = 0) then
    -- Agents never supply amounts: money values come from document extracts or a human.
    adj := CORE.DECISION_TO_ADJ(:decision, :line_no, :dup_of, null);
    call CORE.REPRICE_DRY_RUN(:claim, :adj) into :dry;
  end if;

  insert into AI.PROPOSALS (proposal_id, exception_id, claim_id, agent_name, source, agent_run_id, decision, adjustments,
    dry_run, proposed_allowed_amt, current_allowed_amt, rationale, citations, confidence, risk_flags, schema_valid,
    validation_errors, raw, status)
  select :pid, :P_EXCEPTION_ID, :claim, :P_AGENT, iff(:is_eval, 'EVAL', 'AGENT_TOOL'), :P_RUN_ID, :decision, :adj, :dry,
    :dry:allowed_amt::number(18, 2), :cur, :P_PROPOSAL:rationale::string, :P_PROPOSAL:citations,
    try_to_double(:P_PROPOSAL:confidence::string), coalesce(:P_PROPOSAL:risk_flags, []), array_size(:errs) = 0, :errs,
    :P_PROPOSAL, iff(:is_eval, 'EVAL', iff(array_size(:errs) = 0, 'PENDING', 'INVALID'));

  -- Eval runs record the proposal only; the live queue (exception status, audit log) is untouched.
  if (is_eval) then
    return object_construct('ok', array_size(errs) = 0, 'proposal_id', pid, 'decision', decision, 'errors', errs,
      'current_allowed_amt', cur, 'proposed_allowed_amt', dry:allowed_amt, 'pricing_status', dry:pricing_status,
      'note', 'Proposal recorded for human review. Agents cannot resolve exceptions or release payments.');
  end if;
  if (array_size(errs) = 0) then
    update AI.PROPOSALS set status = 'SUPERSEDED' where exception_id = :P_EXCEPTION_ID and status = 'PENDING' and proposal_id <> :pid;
    update CORE.EXCEPTIONS set status = 'AGENT_PROPOSED', latest_proposal_id = :pid, version = version + 1
      where exception_id = :P_EXCEPTION_ID;
  end if;
  insert into OPS.AUDIT_LOG (sim_ts, actor, persona, action, entity_type, entity_id, detail)
    select OPS.SIM_NOW(), :P_AGENT, 'AGENT', 'PROPOSAL_SUBMITTED', 'EXCEPTION', :P_EXCEPTION_ID,
      object_construct('proposal_id', :pid, 'decision', :decision, 'valid', array_size(:errs) = 0, 'errors', :errs,
                       'proposed_allowed_amt', :dry:allowed_amt);
  return object_construct('ok', array_size(errs) = 0, 'proposal_id', pid, 'decision', decision, 'errors', errs,
    'current_allowed_amt', cur, 'proposed_allowed_amt', dry:allowed_amt, 'pricing_status', dry:pricing_status,
    'note', 'Proposal recorded for human review. Agents cannot resolve exceptions or release payments.');
end;
$$;

-- ---------------------------------------------------------------- exception resolution (humans only)
create or replace procedure CORE.RESOLVE_EXCEPTION_IMPL(P_EXCEPTION_ID string, P_EXPECTED_VERSION int, P_DECISION string,
  P_VALUE number(18,2), P_PROPOSAL_ID string, P_ACTOR string, P_PERSONA string, P_IDEM_KEY string, P_NOTE string)
returns variant language sql execute as owner as
$$
declare
  prior variant; exc_type string; stage string; claim string; line_no int; status string; ver int;
  allowed_stages array; outcome string; needs_value boolean; dup_of string; adj array; agent_decision string;
  orig_status string; result variant; pipe variant; sim_ts timestamp_ntz;
begin
  prior := (select any_value(result) from OPS.IDEMPOTENCY where idem_key = :P_IDEM_KEY);
  if (prior is not null) then return object_insert(prior, 'idempotent_replay', true, true); end if;
  sim_ts := (select OPS.SIM_NOW());

  select exception_type, stage, claim_id, coalesce(line_no, 1), status, version
    into :exc_type, :stage, :claim, :line_no, :status, :ver from CORE.EXCEPTIONS where exception_id = :P_EXCEPTION_ID;
  if (claim is null) then return object_construct('ok', false, 'code', 'NOT_FOUND'); end if;
  if (status in ('RESOLVED', 'ESCALATED')) then return object_construct('ok', false, 'code', 'ALREADY_CLOSED', 'status', status); end if;

  allowed_stages := (select any_value(stages) from OPS.PERSONAS where persona_id = :P_PERSONA);
  if (allowed_stages is null or not array_contains(stage::variant, allowed_stages)
      or (exc_type = 'BANK_CHANGE_HOLD' and P_PERSONA <> 'OPS_LEAD')) then
    insert into OPS.AUDIT_LOG (sim_ts, actor, persona, action, entity_type, entity_id, detail, idempotency_key)
      select :sim_ts, :P_ACTOR, :P_PERSONA, 'RESOLVE_DENIED', 'EXCEPTION', :P_EXCEPTION_ID,
             object_construct('reason', 'persona not permitted for stage ' || :stage), :P_IDEM_KEY;
    return object_construct('ok', false, 'code', 'FORBIDDEN', 'message', P_PERSONA || ' cannot resolve ' || stage || ' exceptions');
  end if;
  if (ver <> P_EXPECTED_VERSION) then return object_construct('ok', false, 'code', 'VERSION_CONFLICT', 'current_version', ver); end if;
  if (exists (select 1 from OPS.EVAL_ACTIVE where exception_id = :P_EXCEPTION_ID and expires_at > current_timestamp())) then
    return object_construct('ok', false, 'code', 'EVAL_IN_PROGRESS');
  end if;
  if (P_PROPOSAL_ID is not null and not exists (select 1 from AI.PROPOSALS
      where proposal_id = :P_PROPOSAL_ID and exception_id = :P_EXCEPTION_ID and status = 'PENDING'
        and schema_valid and source <> 'EVAL')) then
    return object_construct('ok', false, 'code', 'INVALID_PROPOSAL');
  end if;

  select any_value(outcome), any_value(needs_value) into :outcome, :needs_value
    from CORE.DECISIONS where exception_type = :exc_type and decision = :P_DECISION;
  if (outcome is null) then return object_construct('ok', false, 'code', 'INVALID_DECISION'); end if;
  if (needs_value and P_VALUE is null) then return object_construct('ok', false, 'code', 'VALUE_REQUIRED'); end if;

  dup_of := (select first_claim_id from CORE.V_DUPLICATES where claim_id = :claim);
  if (P_DECISION = 'REPLACE_ORIGINAL' and exists (select 1 from CORE.CLAIM_STATE
      where claim_id = :dup_of and status in ('BATCHED', 'RELEASED'))) then
    return object_construct('ok', false, 'code', 'ORIGINAL_PAYMENT_COMMITTED',
      'message', 'Original claim is batched or released; manual recovery is required before replacement.');
  end if;
  adj := CORE.DECISION_TO_ADJ(:P_DECISION, :line_no, :dup_of, :P_VALUE);
  insert into CORE.CLAIM_ADJUSTMENTS (scenario_id, claim_id, line_no, action, value_str, value_num, source_exception_id, created_by)
    select 'LIVE', :claim, value:line_no::int, value:action::string, value:value_str::string, value:value_num::number(18, 2),
           :P_EXCEPTION_ID, :P_ACTOR
    from table(flatten(input => :adj));

  -- side effects outside the claim itself
  if (P_DECISION = 'REPLACE_ORIGINAL' and dup_of is not null) then
    orig_status := (select status from CORE.CLAIM_STATE where claim_id = :dup_of);
    if (orig_status not in ('RELEASED', 'BATCHED')) then
      insert into CORE.CLAIM_ADJUSTMENTS (scenario_id, claim_id, line_no, action, source_exception_id, created_by)
        values ('LIVE', :dup_of, 0, 'VOID_CLAIM', :P_EXCEPTION_ID, :P_ACTOR);
    end if;
  end if;
  if (P_DECISION = 'RELEASE_AFTER_VERIFICATION') then
    update CORE.BANK_ACCOUNTS b set verified = true, verified_at = current_timestamp(), verified_by = :P_ACTOR
      from CORE.CLAIM_STATE s join RAW.CLAIMS c on c.claim_id = s.claim_id
      where c.claim_id = :claim and b.org_id = c.org_id and b.verified = false and b.change_source in ('LETTER', 'PHONE');
  end if;

  agent_decision := (select decision from AI.PROPOSALS where proposal_id = :P_PROPOSAL_ID);
  update CORE.EXCEPTIONS set status = :outcome, resolved_sim_ts = :sim_ts, resolved_at = current_timestamp(),
      resolved_by = :P_ACTOR, version = version + 1,
      resolution = object_construct('decision', :P_DECISION, 'value', :P_VALUE, 'proposal_id', :P_PROPOSAL_ID,
        'agent_decision', :agent_decision, 'agreed_with_agent', :agent_decision = :P_DECISION, 'adjustments', :adj,
        'persona', :P_PERSONA, 'note', :P_NOTE)
    where exception_id = :P_EXCEPTION_ID and version = :P_EXPECTED_VERSION;
  if (sqlrowcount = 0) then return object_construct('ok', false, 'code', 'VERSION_CONFLICT'); end if;
  if (P_PROPOSAL_ID is not null) then
    update AI.PROPOSALS set status = iff(decision = :P_DECISION, 'ACCEPTED', 'OVERRIDDEN') where proposal_id = :P_PROPOSAL_ID;
  end if;

  insert into OPS.AUDIT_LOG (sim_ts, actor, persona, action, entity_type, entity_id, detail, idempotency_key)
    select :sim_ts, :P_ACTOR, :P_PERSONA, 'EXCEPTION_' || :outcome, 'EXCEPTION', :P_EXCEPTION_ID,
      object_construct('claim_id', :claim, 'decision', :P_DECISION, 'value', :P_VALUE, 'proposal_id', :P_PROPOSAL_ID,
                       'agreed_with_agent', :agent_decision = :P_DECISION, 'adjustments', :adj, 'note', :P_NOTE), :P_IDEM_KEY;

  call CORE.RUN_PIPELINE('RESOLVE', array_construct_compact(:claim, iff(:P_DECISION = 'REPLACE_ORIGINAL', :dup_of, null))) into :pipe;
  result := (select object_construct('ok', true, 'exception_id', :P_EXCEPTION_ID, 'outcome', :outcome,
              'claim_id', claim_id, 'claim_status', status, 'allowed_amt', allowed_amt, 'payable_amt', payable_amt)
             from CORE.CLAIM_STATE where claim_id = :claim);
  insert into OPS.IDEMPOTENCY (idem_key, action, result) select :P_IDEM_KEY, 'RESOLVE_EXCEPTION', :result;
  return result;
end;
$$;

-- ---------------------------------------------------------------- payment batches
create table if not exists CORE.PAYMENT_BATCHES (
  batch_id string primary key, payer_id string, pay_method string, status string,  -- DRAFT | APPROVED | RELEASED
  claim_count int, total_amt number(18,2), max_claim_amt number(18,2), created_by string, created_sim_ts timestamp_ntz,
  approved_by string, approved_persona string, approved_sim_ts timestamp_ntz, released_by string,
  released_sim_ts timestamp_ntz, expected_settlement_date date, cutoff_met boolean, version int not null default 1);
create table if not exists CORE.BATCH_ITEMS (batch_id string, claim_id string, payable_amt number(18,2), disposition string);
create table if not exists OPS.RAIL_LEDGER (
  rail_txn_id string, batch_id string, org_id string, rail string, amount number(18,2), trace_number string,
  status string, submitted_sim_ts timestamp_ntz, expected_settlement_date date, adapter string);
create table if not exists OPS.REMITTANCE_FILES (batch_id string, format string, file_path string, content string,
  created_at timestamp_ntz default current_timestamp());

create transient table if not exists CORE.BATCH_BUILD_WORK (
  work_id string, batch_id string, claim_id string, payer_id string, pay_method string,
  payable_amt number(18,2), disposition string);

create or replace procedure CORE.CREATE_BATCHES_IMPL(P_ACTOR string, P_PERSONA string, P_IDEM_KEY string)
returns variant language sql execute as owner as
$$
declare prior variant; ok boolean; n int; sim_ts timestamp_ntz; tag string; result variant;
begin
  prior := (select any_value(result) from OPS.IDEMPOTENCY where idem_key = :P_IDEM_KEY);
  if (prior is not null) then return object_insert(prior, 'idempotent_replay', true, true); end if;
  ok := (select any_value(can_create_batches) from OPS.PERSONAS where persona_id = :P_PERSONA);
  if (not coalesce(ok, false)) then return object_construct('ok', false, 'code', 'FORBIDDEN'); end if;
  sim_ts := (select OPS.SIM_NOW());
  tag := to_char(:sim_ts, 'YYYYMMDD-HH24MI') || '-' || upper(replace(uuid_string(), '-', ''));

  insert into CORE.BATCH_BUILD_WORK
    select :tag, 'BAT-' || :tag || '-' || c.payer_id || '-' || s.pay_method batch_id, s.claim_id, c.payer_id, s.pay_method,
      iff(s.status = 'DENIED', 0, s.payable_amt) payable_amt, iff(s.status = 'DENIED', 'DENIED', 'PAID') disposition
    from CORE.CLAIM_STATE s join RAW.CLAIMS c on c.claim_id = s.claim_id
    where (s.status = 'READY' or (s.status = 'DENIED' and s.batch_id is null));
  n := (select count(*) from CORE.BATCH_BUILD_WORK where work_id = :tag);
  if (n = 0) then return object_construct('ok', true, 'batches', 0, 'claims', 0); end if;

  insert into CORE.PAYMENT_BATCHES (batch_id, payer_id, pay_method, status, claim_count, total_amt, max_claim_amt,
                                    created_by, created_sim_ts)
    select batch_id, payer_id, pay_method, 'DRAFT', count(*), sum(payable_amt), max(payable_amt), :P_ACTOR, :sim_ts
    from CORE.BATCH_BUILD_WORK where work_id = :tag group by 1, 2, 3;
  insert into CORE.BATCH_ITEMS select batch_id, claim_id, payable_amt, disposition from CORE.BATCH_BUILD_WORK where work_id = :tag;
  update CORE.CLAIM_STATE s set status = iff(s.status = 'DENIED', 'DENIED', 'BATCHED'), batch_id = t.batch_id,
      version = s.version + 1, updated_at = current_timestamp()
    from CORE.BATCH_BUILD_WORK t where s.claim_id = t.claim_id and t.work_id = :tag;
  result := (select object_construct('ok', true, 'batches', count(distinct batch_id), 'claims', count(*),
                                     'total_amt', sum(payable_amt), 'batch_ids', array_agg(distinct batch_id))
             from CORE.BATCH_BUILD_WORK where work_id = :tag);
  delete from CORE.BATCH_BUILD_WORK where work_id = :tag;
  insert into OPS.AUDIT_LOG (sim_ts, actor, persona, action, entity_type, entity_id, detail, idempotency_key)
    select :sim_ts, :P_ACTOR, :P_PERSONA, 'BATCHES_CREATED', 'BATCH', null, :result, :P_IDEM_KEY;
  insert into OPS.IDEMPOTENCY (idem_key, action, result) select :P_IDEM_KEY, 'CREATE_BATCHES', :result;
  return result;
end;
$$;

create or replace procedure CORE.APPROVE_BATCH_IMPL(P_BATCH_ID string, P_EXPECTED_VERSION int, P_ACTOR string,
  P_PERSONA string, P_IDEM_KEY string)
returns variant language sql execute as owner as
$$
declare prior variant; st string; ver int; total number(18,2); mx number(18,2); blim number(18,2); clim number(18,2);
  sod int; result variant; sim_ts timestamp_ntz;
begin
  prior := (select any_value(result) from OPS.IDEMPOTENCY where idem_key = :P_IDEM_KEY);
  if (prior is not null) then return object_insert(prior, 'idempotent_replay', true, true); end if;
  sim_ts := (select OPS.SIM_NOW());
  select status, version, total_amt, max_claim_amt into :st, :ver, :total, :mx from CORE.PAYMENT_BATCHES where batch_id = :P_BATCH_ID;
  if (st is null) then return object_construct('ok', false, 'code', 'NOT_FOUND'); end if;
  if (st <> 'DRAFT') then return object_construct('ok', false, 'code', 'INVALID_STATE', 'status', st); end if;
  if (ver <> P_EXPECTED_VERSION) then return object_construct('ok', false, 'code', 'VERSION_CONFLICT', 'current_version', ver); end if;
  select any_value(batch_limit), any_value(claim_limit) into :blim, :clim from OPS.PERSONAS where persona_id = :P_PERSONA;
  if (coalesce(blim, 0) = 0) then return object_construct('ok', false, 'code', 'FORBIDDEN', 'message', P_PERSONA || ' cannot approve payments'); end if;
  if (total > blim or mx > clim) then
    insert into OPS.AUDIT_LOG (sim_ts, actor, persona, action, entity_type, entity_id, detail, idempotency_key)
      select :sim_ts, :P_ACTOR, :P_PERSONA, 'APPROVAL_DENIED_LIMIT', 'BATCH', :P_BATCH_ID,
        object_construct('total', :total, 'max_claim', :mx, 'batch_limit', :blim, 'claim_limit', :clim), :P_IDEM_KEY;
    return object_construct('ok', false, 'code', 'OVER_LIMIT', 'total_amt', total, 'max_claim_amt', mx,
                            'batch_limit', blim, 'claim_limit', clim);
  end if;
  -- segregation of duties: approver may not have resolved an exception on any claim in the batch
  sod := (select count(*) from CORE.BATCH_ITEMS i join CORE.EXCEPTIONS e on e.claim_id = i.claim_id
          where i.batch_id = :P_BATCH_ID and e.resolved_by = :P_ACTOR);
  if (sod > 0) then return object_construct('ok', false, 'code', 'SEGREGATION_OF_DUTIES', 'conflicting_claims', sod); end if;

  update CORE.PAYMENT_BATCHES set status = 'APPROVED', approved_by = :P_ACTOR, approved_persona = :P_PERSONA,
      approved_sim_ts = :sim_ts, version = version + 1
    where batch_id = :P_BATCH_ID and version = :P_EXPECTED_VERSION;
  if (sqlrowcount = 0) then return object_construct('ok', false, 'code', 'VERSION_CONFLICT'); end if;
  result := object_construct('ok', true, 'batch_id', P_BATCH_ID, 'status', 'APPROVED', 'total_amt', total);
  insert into OPS.AUDIT_LOG (sim_ts, actor, persona, action, entity_type, entity_id, detail, idempotency_key)
    select :sim_ts, :P_ACTOR, :P_PERSONA, 'BATCH_APPROVED', 'BATCH', :P_BATCH_ID, :result, :P_IDEM_KEY;
  insert into OPS.IDEMPOTENCY (idem_key, action, result) select :P_IDEM_KEY, 'APPROVE_BATCH', :result;
  return result;
end;
$$;

-- Rail simulator adapter: this is where a real ACH (NACHA) or virtual-card issuer integration would plug in.
-- Same-day ACH cut-off 14:45 ET = business minute 405.
create or replace procedure CORE.RELEASE_BATCH_IMPL(P_BATCH_ID string, P_EXPECTED_VERSION int, P_ACTOR string,
  P_PERSONA string, P_IDEM_KEY string)
returns variant language sql execute as owner as
$$
declare prior variant; st string; ver int; method string; can boolean; sim_ts timestamp_ntz; sim_min int; sim_d date;
  settle date; cutoff boolean; result variant; content string; path string;
begin
  prior := (select any_value(result) from OPS.IDEMPOTENCY where idem_key = :P_IDEM_KEY);
  if (prior is not null) then return object_insert(prior, 'idempotent_replay', true, true); end if;
  select status, version, pay_method into :st, :ver, :method from CORE.PAYMENT_BATCHES where batch_id = :P_BATCH_ID;
  if (st is null) then return object_construct('ok', false, 'code', 'NOT_FOUND'); end if;
  if (st <> 'APPROVED') then return object_construct('ok', false, 'code', 'INVALID_STATE', 'status', st); end if;
  if (ver <> P_EXPECTED_VERSION) then return object_construct('ok', false, 'code', 'VERSION_CONFLICT', 'current_version', ver); end if;
  can := (select any_value(can_release) from OPS.PERSONAS where persona_id = :P_PERSONA);
  if (not coalesce(can, false)) then return object_construct('ok', false, 'code', 'FORBIDDEN'); end if;

  sim_ts := (select OPS.SIM_NOW());
  select sim_minute, OPS.SIM_DATE() into :sim_min, :sim_d from OPS.SIM_STATE;
  cutoff := (method = 'VCARD') or (method = 'ACH' and sim_min <= 405);
  settle := case when method = 'VCARD' then sim_d when method = 'ACH' and sim_min <= 405 then sim_d
                 when method = 'ACH' then dateadd(day, iff(dayofweekiso(sim_d) >= 5, 8 - dayofweekiso(sim_d), 1), sim_d)
                 else dateadd(day, iff(dayofweekiso(sim_d) >= 4, 9 - dayofweekiso(sim_d), 2), sim_d) end;

  update CORE.PAYMENT_BATCHES set status = 'RELEASED', released_by = :P_ACTOR, released_sim_ts = :sim_ts,
      expected_settlement_date = :settle, cutoff_met = :cutoff, version = version + 1
    where batch_id = :P_BATCH_ID and version = :P_EXPECTED_VERSION;
  if (sqlrowcount = 0) then return object_construct('ok', false, 'code', 'VERSION_CONFLICT'); end if;

  insert into OPS.RAIL_LEDGER (rail_txn_id, batch_id, org_id, rail, amount, trace_number, status, submitted_sim_ts,
                               expected_settlement_date, adapter)
    select 'RTX-' || uuid_string(), :P_BATCH_ID, c.org_id, :method, sum(i.payable_amt),
      lpad(abs(hash(:P_BATCH_ID || c.org_id)) % 1000000000000000, 15, '0'), 'SUBMITTED', :sim_ts, :settle, 'SIMULATOR'
    from CORE.BATCH_ITEMS i join RAW.CLAIMS c on c.claim_id = i.claim_id
    where i.batch_id = :P_BATCH_ID and i.disposition = 'PAID' group by c.org_id having sum(i.payable_amt) > 0;
  update CORE.CLAIM_STATE s set status = iff(s.status = 'DENIED', 'DENIED', 'RELEASED'), released_sim_ts = :sim_ts,
      version = s.version + 1, updated_at = current_timestamp()
    from CORE.BATCH_ITEMS i where i.batch_id = :P_BATCH_ID and s.claim_id = i.claim_id;

  -- 835-style remittance (simplified segments; not a certified X12 implementation)
  content := (
    select 'ISA*00*          *00*          *ZZ*ZELISC2C       *ZZ*' || rpad(any_value(b.payer_id), 15, ' ') || '*' ||
      to_char(:sim_ts, 'YYMMDD') || '*' || to_char(:sim_ts, 'HH24MI') || '*^*00501*000000001*0*T*:~\n' ||
      'GS*HP*ZELISC2C*' || any_value(b.payer_id) || '*' || to_char(:sim_ts, 'YYYYMMDD') || '*' || to_char(:sim_ts, 'HH24MI') || '*1*X*005010X221A1~\n' ||
      'ST*835*0001~\n' ||
      'BPR*I*' || to_char(sum(i.payable_amt), 'FM999999990.00') || '*C*' ||
        decode(any_value(b.pay_method), 'ACH', 'ACH', 'VCARD', 'BOP', 'CHK') || '************' ||
        to_char(:settle, 'YYYYMMDD') || '~\n' ||
      'TRN*1*' || :P_BATCH_ID || '*1ZELISC2C~\n' ||
      'N1*PR*' || any_value(p.payer_name) || '~\n' ||
      listagg('CLP*' || i.claim_id || '*' || iff(i.disposition = 'DENIED', '4', '1') || '*' ||
              to_char(c.billed_amt, 'FM999999990.00') || '*' || to_char(i.payable_amt, 'FM999999990.00') ||
              '**12~\nNM1*85*2*' || o.org_name || '*****XX*' || pr.npi || '~\n' ||
              iff(i.disposition = 'DENIED', 'CAS*CO*18*' || to_char(c.billed_amt, 'FM999999990.00') || '~\n',
                  iff(c.billed_amt > i.payable_amt, 'CAS*CO*45*' || to_char(c.billed_amt - i.payable_amt, 'FM999999990.00') || '~\n', '')),
              '') within group (order by i.claim_id) ||
      'SE*' || (count(*) * 3 + 6) || '*0001~\nGE*1*1~\nIEA*1*000000001~'
    from CORE.BATCH_ITEMS i
    join CORE.PAYMENT_BATCHES b on b.batch_id = i.batch_id
    join RAW.CLAIMS c on c.claim_id = i.claim_id
    join CORE.PROVIDER_ORGS o on o.org_id = c.org_id
    join CORE.PROVIDERS pr on pr.provider_id = c.provider_id
    join CORE.PAYERS p on p.payer_id = b.payer_id
    where i.batch_id = :P_BATCH_ID);
  path := '835/' || P_BATCH_ID || '.835';
  insert into OPS.REMITTANCE_FILES (batch_id, format, file_path, content) values (:P_BATCH_ID, '835', :path, :content);
  -- Stage export is performed after the database transaction commits (see 09_atomic_workflows.sql).
  -- REMITTANCE_FILES is the durable outbox; an export failure is retried without releasing money again.

  result := (select object_construct('ok', true, 'batch_id', :P_BATCH_ID, 'status', 'RELEASED', 'rail', :method,
               'cutoff_met', :cutoff, 'expected_settlement_date', :settle, 'remittance_file', :path,
               'rail_transactions', count(*), 'amount', sum(amount))
             from OPS.RAIL_LEDGER where batch_id = :P_BATCH_ID);
  insert into OPS.AUDIT_LOG (sim_ts, actor, persona, action, entity_type, entity_id, detail, idempotency_key)
    select :sim_ts, :P_ACTOR, :P_PERSONA, 'BATCH_RELEASED', 'BATCH', :P_BATCH_ID, :result, :P_IDEM_KEY;
  insert into OPS.IDEMPOTENCY (idem_key, action, result) select :P_IDEM_KEY, 'RELEASE_BATCH', :result;
  return result;
end;
$$;

-- ---------------------------------------------------------------- reset
-- Keeps AI.DOC_EXTRACTS by default (re-running OCR/extraction on reset costs credits and changes nothing).
create or replace procedure OPS.SIM_RESET(P_KEEP_AI_CACHE boolean, P_ACTOR string)
returns variant language sql execute as owner as
$$
begin
  alter task OPS.T_SIM_TICK suspend;
  truncate table RAW.CLAIMS; truncate table RAW.CLAIM_LINES; truncate table RAW.ATTACHMENTS;
  truncate table CORE.CLAIM_STATE; truncate table CORE.EXCEPTIONS; truncate table CORE.RULE_HITS;
  truncate table CORE.CLAIM_ADJUSTMENTS; truncate table CORE.PIPELINE_WORK;
  truncate table CORE.W_PRICE_INPUT; truncate table CORE.W_PRICED_LINES; truncate table CORE.W_PRICED_CLAIMS;
  truncate table CORE.W_RULE_FEATURES;
  truncate table CORE.PAYMENT_BATCHES; truncate table CORE.BATCH_ITEMS; truncate table OPS.RAIL_LEDGER;
  truncate table OPS.REMITTANCE_FILES; truncate table OPS.IDEMPOTENCY; truncate table OPS.PIPELINE_RUNS;
  truncate table AI.PROPOSALS;
  if (not coalesce(:P_KEEP_AI_CACHE, true)) then truncate table AI.DOC_EXTRACTS; end if;
  -- Stage files are left in place (REMOVE is not allowed in procedures); scripts/reset.sh clears them.
  update CORE.BANK_ACCOUNTS set verified = false, verified_at = null, verified_by = null where change_source = 'LETTER';
  update OPS.SIM_STATE set sim_day = 1, sim_minute = 0, status = 'PAUSED', updated_at = current_timestamp();
  insert into OPS.AUDIT_LOG (sim_ts, actor, persona, action, entity_type, detail)
    select OPS.SIM_NOW(), :P_ACTOR, 'OPS_LEAD', 'SIM_RESET', 'SIMULATION', object_construct('keep_ai_cache', :P_KEEP_AI_CACHE);
  return object_construct('ok', true);
end;
$$;
