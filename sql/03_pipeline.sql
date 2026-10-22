-- 03_pipeline.sql — intake AI, rules-as-data, claim state, simulator, scheduled task.
use role ZELIS_C2C_ROLE;
use warehouse ZELIS_C2C_WH;
use database ZELIS_C2C;

-- ---------------------------------------------------------------- rules as data
-- predicate_sql is evaluated against CORE.V_RULE_FEATURES (one row per claim line). New rules are inserted as
-- new versions; only one version per rule_id is active. The Rules Studio (Phase 6) can only write DRAFT rows.
create table if not exists CORE.RULES (
  rule_id string not null, version int not null, status string not null,  -- DRAFT | ACTIVE | RETIRED
  stage string not null, exception_type string not null, title string not null, predicate_sql string not null,
  owner_persona string not null, created_by string, created_at timestamp_ntz default current_timestamp(),
  activated_at timestamp_ntz, notes string);

merge into CORE.RULES t using (
  select column1 rule_id, column2 stage, column3 exception_type, column4 title, column5 predicate_sql, column6 owner_persona
  from values
  ('PR_BILATERAL_UNITS', 'PRICING', 'MODIFIER_REVIEW', 'Bilateral-eligible code billed with 2 units and no modifier 50',
   'bilateral_eligible and units = 2 and not array_contains(''50''::variant, eff_mods)', 'PRICING_ANALYST'),
  ('PR_CARVEOUT_CONFLICT', 'PRICING', 'CONTRACT_CONFLICT', 'Code matches more than one contract carve-out',
   'price_method = ''CARVEOUT_CONFLICT''', 'PRICING_ANALYST'),
  ('PR_NEEDS_INVOICE', 'PRICING', 'DOC_REVIEW', 'Invoice-priced implant without a confidently extracted invoice total',
   'price_method = ''NEEDS_INVOICE''', 'PRICING_ANALYST'),
  ('PR_STOP_LOSS', 'PRICING', 'STOP_LOSS_REVIEW', 'Billed charges exceed the contract stop-loss threshold',
   'stop_loss_applies and line_no = 1', 'PRICING_ANALYST'),
  ('PR_OON_HIGH_DOLLAR', 'PRICING', 'OON_REVIEW', 'Out-of-network claim above the payer review threshold',
   'network_kind = ''SOLO_OON'' and claim_billed > oon_review_threshold and line_no = 1', 'PRICING_ANALYST'),
  ('PI_DUPLICATE', 'INTEGRITY', 'DUPLICATE_SUSPECT', 'Same provider, member, date of service and codes as an earlier claim',
   'dup_of_claim_id is not null and line_no = 1', 'INTEGRITY_REVIEWER'),
  ('PI_UNBUNDLING', 'INTEGRITY', 'UNBUNDLING', 'Component code billed with its comprehensive code without a distinct-procedure modifier',
   'edit_pair_component', 'INTEGRITY_REVIEWER'),
  ('PI_EM_LEVEL5_PREPAY', 'INTEGRITY', 'EM_LEVEL_REVIEW', 'Level-5 E/M from a provider under pre-payment review',
   'eff_code = ''99215'' and em_prepay_review', 'INTEGRITY_REVIEWER'),
  ('PY_BANK_CHANGE_HOLD', 'PAYMENT', 'BANK_CHANGE_HOLD', 'Payee bank account changed by letter/phone within 7 days and not verified',
   'bank_change_hold and line_no = 1', 'OPS_LEAD')
) s on t.rule_id = s.rule_id and t.version = 1
when not matched then insert (rule_id, version, status, stage, exception_type, title, predicate_sql, owner_persona, created_by, activated_at)
  values (s.rule_id, 1, 'ACTIVE', s.stage, s.exception_type, s.title, s.predicate_sql, s.owner_persona, 'bootstrap', current_timestamp());

-- ---------------------------------------------------------------- claim state + exceptions
create table if not exists CORE.CLAIM_STATE (
  claim_id string primary key, status string not null,
  -- RECEIVED | EXCEPTION | READY | BATCHED | RELEASED | DENIED | OFFER_PENDING | HELD
  allowed_amt number(18,2), payable_amt number(18,2), pricing_status string, pricing_snapshot variant,
  pay_method string, same_day_eligible boolean, open_exceptions int default 0,
  received_sim_ts timestamp_ntz, priced_sim_ts timestamp_ntz, ready_sim_ts timestamp_ntz,
  released_sim_ts timestamp_ntz, batch_id string, version int not null default 1,
  updated_at timestamp_ntz default current_timestamp());

create table if not exists CORE.EXCEPTIONS (
  exception_id string primary key, claim_id string not null, stage string not null, exception_type string not null,
  rule_id string not null, rule_version int not null, line_no int, details variant,
  status string not null,  -- NEW | AGENT_WORKING | AGENT_PROPOSED | RESOLVED | ESCALATED
  owner_persona string not null, opened_sim_ts timestamp_ntz, opened_at timestamp_ntz default current_timestamp(),
  resolved_sim_ts timestamp_ntz, resolved_at timestamp_ntz, resolved_by string, resolution variant,
  latest_proposal_id string, version int not null default 1);

create table if not exists CORE.RULE_HITS (
  run_id string, claim_id string, line_no int, rule_id string, rule_version int, hit_at timestamp_ntz default current_timestamp());

create transient table if not exists CORE.PIPELINE_WORK (run_id string, claim_id string);

create table if not exists OPS.PIPELINE_RUNS (
  run_id string, started_at timestamp_ntz, finished_at timestamp_ntz, sim_ts timestamp_ntz, trigger_source string,
  claims int, attachments int, exceptions_opened int, ready int, status string, error string);

-- ---------------------------------------------------------------- intake (AI functions)
-- Per-type extraction schemas: classify first, then extract only the fields that exist on that document type
-- (a generic schema mis-reads look-alike fields across types, e.g. billed total as invoice total).
create or replace table AI.DOC_TYPE_SCHEMAS (doc_type string, response_format variant, money_fields array);
insert into AI.DOC_TYPE_SCHEMAS select 'implant_invoice', parse_json('{"schema":{"type":"object","properties":{
  "invoice_total":{"description":"What is the INVOICE TOTAL amount?","type":"string"},
  "vendor":{"description":"What company issued the invoice?","type":"string"},
  "invoice_number":{"description":"What is the invoice number?","type":"string"},
  "device_code":{"description":"What HCPCS device code (for example C1776 or L8699) appears on the line items?","type":"string"}}}}'),
  ['invoice_total']
union all select 'itemized_bill', parse_json('{"schema":{"type":"object","properties":{
  "total_billed":{"description":"What are the TOTAL BILLED CHARGES?","type":"string"},
  "total_non_covered":{"description":"What is the TOTAL NON-COVERED amount?","type":"string"},
  "non_covered_items":{"description":"Which line descriptions are marked non-covered?","type":"array"}}}}'),
  ['total_non_covered']
union all select 'operative_note', parse_json('{"schema":{"type":"object","properties":{
  "laterality":{"description":"Was the procedure performed on both sides, the left side only, or the right side only? Answer exactly one word: bilateral, left, or right.","type":"string"},
  "procedure_code":{"description":"What procedure code was reported?","type":"string"},
  "laterality_sentence":{"description":"Quote the sentence that states which side or sides were treated.","type":"string"}}}}'),
  []
union all select 'visit_note', parse_json('{"schema":{"type":"object","properties":{
  "assessment_plan":{"description":"What is written under Assessment and plan?","type":"string"},
  "level_billed":{"description":"What visit level was billed?","type":"string"}}}}'),
  []
union all select 'bank_change_letter', parse_json('{"schema":{"type":"object","properties":{
  "payee_name":{"description":"Who is the payee the payments should go to?","type":"string"},
  "payee_tin":{"description":"What TIN is given for the payee?","type":"string"},
  "new_bank_name":{"description":"What is the name of the new bank?","type":"string"},
  "new_bank_state":{"description":"What state is the new bank in (two-letter code)?","type":"string"},
  "effective_date":{"description":"What is the effective date of the change?","type":"string"},
  "contact_email":{"description":"What is the contact email address?","type":"string"},
  "verification_text":{"description":"Quote the sentence about verification or how to confirm the request.","type":"string"},
  "urgent_language":{"description":"Does the letter use urgency language such as URGENT? Answer yes or no.","type":"string"}}}}'),
  []
union all select 'w9', parse_json('{"schema":{"type":"object","properties":{
  "name":{"description":"What is the taxpayer name?","type":"string"},
  "tin":{"description":"What is the TIN?","type":"string"}}}}'),
  [];

create or replace procedure AI.PROCESS_ATTACHMENTS()
returns variant language sql execute as owner as
$$
declare n_parsed int default 0; n_extracted int default 0; t_start timestamp_ntz default current_timestamp();
begin
  -- 1) parse (OCR mode: ~1s/page vs ~15-35s for LAYOUT, and cheaper). The text feeds classification and agent
  --    context; field extraction reads the file directly in step 3, so table structure is not lost.
  --    AI_PARSE_DOCUMENT returns NULL (not an error) on transient failure: retry up to 3 attempts, then leave the
  --    claim on the document-review path.
  merge into AI.DOC_EXTRACTS t using (
    select a.attachment_id, a.claim_id, a.file_name,
      parse_json(to_varchar(AI_PARSE_DOCUMENT(TO_FILE('@RAW.INTAKE', a.file_name), {'mode': 'OCR'}))) j
    from RAW.ATTACHMENTS a
    left join AI.DOC_EXTRACTS d on d.attachment_id = a.attachment_id
    where d.attachment_id is null or (d.status = 'PARSE_FAILED' and coalesce(d.attempts, 1) < 3)) s
  on t.attachment_id = s.attachment_id
  when matched then update set parsed_text = s.j:content::string, page_count = s.j:metadata:pageCount::int,
    attempts = coalesce(t.attempts, 1) + 1, parsed_at = current_timestamp(),
    status = iff(length(coalesce(s.j:content::string, '')) < 40, 'PARSE_FAILED', 'PARSED'),
    error = iff(length(coalesce(s.j:content::string, '')) < 40, 'empty or near-empty OCR output', null)
  when not matched then insert (attachment_id, claim_id, file_name, page_count, parsed_text, status, error, parsed_at, attempts)
    values (s.attachment_id, s.claim_id, s.file_name, s.j:metadata:pageCount::int, s.j:content::string,
      iff(length(coalesce(s.j:content::string, '')) < 40, 'PARSE_FAILED', 'PARSED'),
      iff(length(coalesce(s.j:content::string, '')) < 40, 'empty or near-empty OCR output', null), current_timestamp(), 1);
  n_parsed := sqlrowcount;

  -- 2) classify
  update AI.DOC_EXTRACTS d set doc_type = c.doc_type
  from (select attachment_id,
          AI_CLASSIFY(parsed_text, ['operative_note', 'implant_invoice', 'itemized_bill', 'visit_note',
                                    'bank_change_letter', 'w9', 'other'],
                      {'task_description': 'Classify a healthcare claim attachment by document type'}):labels[0]::string doc_type
        from AI.DOC_EXTRACTS where status = 'PARSED' and doc_type is null) c
  where d.attachment_id = c.attachment_id;

  -- 3) extract with the type's schema, keep scores
  update AI.DOC_EXTRACTS d set fields = x.r:response, scores = x.r:scoring:scores, extracted_at = current_timestamp(),
    min_score = x.min_money_score,
    status = iff(x.r:error is not null and x.r:error::string <> '', 'EXTRACT_FAILED',
                 iff(coalesce(x.min_money_score, 1) >= 0.85, 'OK', 'LOW_CONFIDENCE')),
    error = nullif(x.r:error::string, '')
  from (
    select e.attachment_id, any_value(e.r) r, min(e.r:scoring:scores[f.value::string]:score::float) min_money_score
    from (
      select d2.attachment_id, s.money_fields,
        AI_EXTRACT(file => TO_FILE('@RAW.INTAKE', d2.file_name), responseFormat => s.response_format, scores => true) r
      from AI.DOC_EXTRACTS d2 join AI.DOC_TYPE_SCHEMAS s on s.doc_type = d2.doc_type
      where d2.status = 'PARSED') e,
      lateral flatten(input => e.money_fields, outer => true) f
    group by e.attachment_id) x
  where d.attachment_id = x.attachment_id;
  n_extracted := sqlrowcount;

  update AI.DOC_EXTRACTS set status = 'UNSUPPORTED_TYPE' where status = 'PARSED' and doc_type = 'other';
  return object_construct('parsed', n_parsed, 'extracted', n_extracted,
    'claims_with_new_facts', (select array_agg(distinct claim_id) from AI.DOC_EXTRACTS
                              where extracted_at >= :t_start and status = 'OK'));
end;
$$;

-- ---------------------------------------------------------------- rules engine
create or replace procedure CORE.RUN_RULES(P_RUN_ID string)
returns int language sql execute as owner as
$$
declare
  q string default '';
  c1 cursor for select rule_id, version, predicate_sql from CORE.RULES where status = 'ACTIVE' order by rule_id;
  n int default 0;
begin
  for r in c1 do
    q := q || iff(q = '', '', ' union all ') ||
         'select ''' || :P_RUN_ID || ''', f.claim_id, f.line_no, ''' || r.rule_id || ''', ' || r.version ||
         ' from CORE.W_RULE_FEATURES f where f.run_id = ''' || :P_RUN_ID || ''' and (' || r.predicate_sql || ')';
  end for;
  if (q = '') then return 0; end if;
  execute immediate 'insert into CORE.RULE_HITS (run_id, claim_id, line_no, rule_id, rule_version) ' || q;
  select count(*) into :n from CORE.RULE_HITS where run_id = :P_RUN_ID;
  return n;
end;
$$;

-- ---------------------------------------------------------------- pipeline: price, rules, route, readiness
-- Processes claims in RECEIVED status (new) plus any claims passed in P_CLAIM_IDS (re-evaluation after a
-- resolution). Idempotent: rule hits already turned into an exception (open or resolved) never re-open.
create or replace procedure CORE.RUN_PIPELINE(P_TRIGGER string, P_CLAIM_IDS array)
returns variant language sql execute as owner as
$$
declare
  run_id string default uuid_string();
  sim_ts timestamp_ntz;
  n_claims int default 0; n_exc int default 0; n_ready int default 0; att variant;
begin
  sim_ts := (select OPS.SIM_NOW());
  insert into OPS.PIPELINE_RUNS (run_id, started_at, sim_ts, trigger_source, status)
    values (:run_id, current_timestamp(), :sim_ts, :P_TRIGGER, 'RUNNING');

  call AI.PROCESS_ATTACHMENTS() into :att;

  insert into CORE.PIPELINE_WORK (run_id, claim_id)
    select :run_id, claim_id from CORE.CLAIM_STATE where status = 'RECEIVED'
    union select :run_id, value::string from table(flatten(input => coalesce(:P_CLAIM_IDS, [])))
    -- late-arriving document facts (e.g. an OCR retry succeeded) re-price claims that are not yet batched
    union select :run_id, s.claim_id from CORE.CLAIM_STATE s
      join table(flatten(input => coalesce(:att:claims_with_new_facts, []))) f on f.value::string = s.claim_id
      where s.status in ('EXCEPTION', 'READY', 'HELD');
  n_claims := (select count(*) from CORE.PIPELINE_WORK where run_id = :run_id);
  if (n_claims = 0) then
    update OPS.PIPELINE_RUNS set finished_at = current_timestamp(), status = 'NOOP', claims = 0,
      attachments = :att:parsed::int where run_id = :run_id;
    return object_construct('run_id', run_id, 'claims', 0);
  end if;

  call CORE.PRICE_WORK(:run_id, 'LIVE');
  call CORE.RUN_RULES(:run_id);

  -- open exceptions for new rule hits (one per claim+rule+line; never re-open a resolved one)
  insert into CORE.EXCEPTIONS (exception_id, claim_id, stage, exception_type, rule_id, rule_version, line_no, details,
                               status, owner_persona, opened_sim_ts)
  select 'EXC-' || h.claim_id || '-' || h.rule_id || iff(r.exception_type in ('UNBUNDLING', 'MODIFIER_REVIEW', 'EM_LEVEL_REVIEW', 'CONTRACT_CONFLICT', 'DOC_REVIEW'), '-L' || h.line_no, ''),
    h.claim_id, r.stage, r.exception_type, h.rule_id, h.rule_version,
    iff(r.exception_type in ('UNBUNDLING', 'MODIFIER_REVIEW', 'EM_LEVEL_REVIEW', 'CONTRACT_CONFLICT', 'DOC_REVIEW'), h.line_no, null),
    object_construct('rule_title', r.title), 'NEW', r.owner_persona, :sim_ts
  from (select distinct claim_id, iff(rule_id in ('PR_STOP_LOSS', 'PR_OON_HIGH_DOLLAR', 'PI_DUPLICATE', 'PY_BANK_CHANGE_HOLD'), 1, line_no) line_no,
               rule_id, rule_version from CORE.RULE_HITS where run_id = :run_id) h
  join CORE.RULES r on r.rule_id = h.rule_id and r.version = h.rule_version
  where not exists (select 1 from CORE.EXCEPTIONS e where e.claim_id = h.claim_id and e.rule_id = h.rule_id
                    and coalesce(e.line_no, 1) = h.line_no);
  n_exc := sqlrowcount;

  -- snapshot pricing + readiness into claim state
  merge into CORE.CLAIM_STATE t using (
    with lines as (
      select l.claim_id, array_agg(object_construct('line_no', l.line_no, 'code', l.eff_code, 'billed_code', l.billed_code,
               'mods', l.eff_mods, 'units', l.units, 'billed', l.line_billed, 'method', l.price_method,
               'pct', l.pct_applied, 'base_rate', l.base_rate, 'modifier_factor', l.modifier_factor,
               'invoice_cost', l.invoice_cost, 'invoice_source', l.invoice_source, 'carveout', l.carveout,
               'allowed', l.line_allowed)) within group (order by l.line_no) lines
      from CORE.W_PRICED_LINES l
      where l.run_id = :run_id group by l.claim_id),
    exc as (
      select e.claim_id, count_if(e.status not in ('RESOLVED', 'ESCALATED')) open_exc, count_if(e.status = 'ESCALATED') escalated,
        count_if(e.status = 'RESOLVED' and e.resolution:decision::string = 'NEGOTIATE_OFFER') offer
      from CORE.EXCEPTIONS e join CORE.PIPELINE_WORK w on w.claim_id = e.claim_id and w.run_id = :run_id
      group by e.claim_id)
    select w.claim_id, pc.allowed_amt, pc.pricing_status, pc.claim_denial, pc.payment_hold,
      object_construct('contract_id', pc.contract_id, 'network_kind', pc.network_kind, 'billed', pc.claim_billed,
        'stop_loss', pc.stop_loss_applies, 'non_covered', pc.non_covered, 'non_covered_source', pc.non_covered_source,
        'capped_at_billed', pc.capped_at_billed, 'unresolved', pc.unresolved_reasons, 'lines', ln.lines) snapshot,
      o.pay_method, (o.epay_enrolled and o.pay_method in ('ACH', 'VCARD')) same_day_eligible,
      coalesce(exc.open_exc, 0) open_exc, coalesce(exc.escalated, 0) escalated, coalesce(exc.offer, 0) offer,
      prior.payable_paid
    from CORE.PIPELINE_WORK w
    join CORE.W_PRICED_CLAIMS pc on pc.claim_id = w.claim_id and pc.run_id = :run_id
    join CORE.PROVIDER_ORGS o on o.org_id = pc.org_id
    left join lines ln on ln.claim_id = w.claim_id
    left join exc on exc.claim_id = w.claim_id
    left join (  -- corrected claims: net out what was already released on the original
      select a.claim_id, sum(cs.payable_amt) payable_paid
      from CORE.CLAIM_ADJUSTMENTS a join CORE.CLAIM_STATE cs on cs.claim_id = a.value_str and cs.status = 'RELEASED'
      where a.scenario_id = 'LIVE' and a.action = 'REPLACES_CLAIM' group by 1) prior on prior.claim_id = w.claim_id
    where w.run_id = :run_id) s
  on t.claim_id = s.claim_id
  when matched and t.status not in ('BATCHED', 'RELEASED') then update set
    allowed_amt = s.allowed_amt, pricing_status = s.pricing_status, pricing_snapshot = s.snapshot,
    payable_amt = iff(s.allowed_amt is null, null, s.allowed_amt - coalesce(s.payable_paid, 0)),
    pay_method = s.pay_method, same_day_eligible = s.same_day_eligible, open_exceptions = s.open_exc,
    status = case when s.claim_denial is not null then 'DENIED'
                  when s.open_exc > 0 then 'EXCEPTION'
                  when s.payment_hold or s.escalated > 0 then 'HELD'
                  when s.offer > 0 then 'OFFER_PENDING'
                  when s.allowed_amt is null then 'EXCEPTION'
                  else 'READY' end,
    priced_sim_ts = coalesce(t.priced_sim_ts, :sim_ts),
    ready_sim_ts = iff(s.open_exc = 0 and s.escalated = 0 and s.claim_denial is null and not s.payment_hold and s.offer = 0
                       and s.allowed_amt is not null, coalesce(t.ready_sim_ts, :sim_ts), null),
    version = t.version + 1, updated_at = current_timestamp();

  n_ready := (select count(*) from CORE.CLAIM_STATE s join CORE.PIPELINE_WORK w on w.claim_id = s.claim_id
              where w.run_id = :run_id and s.status = 'READY');
  call CORE.CLEAR_WORK(:run_id);
  update OPS.PIPELINE_RUNS set finished_at = current_timestamp(), status = 'OK', claims = :n_claims,
    attachments = :att:parsed::int, exceptions_opened = :n_exc, ready = :n_ready where run_id = :run_id;
  return object_construct('run_id', run_id, 'claims', n_claims, 'exceptions_opened', n_exc, 'ready', n_ready,
                          'attachments', att);
exception
  when other then
    update OPS.PIPELINE_RUNS set finished_at = current_timestamp(), status = 'ERROR',
      error = :sqlerrm where run_id = :run_id;
    call CORE.CLEAR_WORK(:run_id);
    raise;
end;
$$;

-- ---------------------------------------------------------------- simulator
-- Lands claims + attachments whose (sim_day, release_minute) has passed, copying files into @RAW.INTAKE.
create or replace procedure OPS.SIM_LAND(P_DAY int, P_UPTO_MINUTE int)
returns variant language sql execute as owner as
$$
declare n_claims int default 0; n_files int default 0; files string; base_ts timestamp_ntz;
begin
  base_ts := (select dateadd(day, :P_DAY - 1, sim_start)::timestamp_ntz from OPS.SIM_STATE);
  insert into RAW.CLAIMS (claim_id, payer_id, provider_id, org_id, member_id, claim_type, frequency_code, service_from,
                          service_to, billed_amt, sim_day, received_at)
  select s.claim_id, s.payer_id, s.provider_id, s.org_id, s.member_id, s.claim_type, s.frequency_code, s.service_from,
    s.service_to, s.billed_amt, s.sim_day, dateadd(minute, 480 + s.release_minute, :base_ts)
  from RAW.CLAIMS_SOURCE s
  where s.sim_day = :P_DAY and s.release_minute < :P_UPTO_MINUTE
    and not exists (select 1 from RAW.CLAIMS c where c.claim_id = s.claim_id);
  n_claims := sqlrowcount;

  insert into RAW.CLAIM_LINES (claim_id, line_no, code, modifiers, units, billed_amt)
  select l.claim_id, l.line_no, l.code, iff(l.modifiers is null, array_construct(), split(l.modifiers, ',')), l.units, l.billed_amt
  from RAW.CLAIM_LINES_SOURCE l join RAW.CLAIMS c on c.claim_id = l.claim_id
  where not exists (select 1 from RAW.CLAIM_LINES x where x.claim_id = l.claim_id and x.line_no = l.line_no);

  insert into CORE.CLAIM_STATE (claim_id, status, received_sim_ts)
  select c.claim_id, 'RECEIVED', c.received_at from RAW.CLAIMS c
  where not exists (select 1 from CORE.CLAIM_STATE s where s.claim_id = c.claim_id);

  select listagg('''' || a.file_name || '''', ',') into :files
  from RAW.ATTACHMENTS_SOURCE a join RAW.CLAIMS c on c.claim_id = a.claim_id
  where not exists (select 1 from RAW.ATTACHMENTS x where x.attachment_id = a.attachment_id);
  if (files is not null and files <> '') then
    execute immediate 'copy files into @RAW.INTAKE from @RAW.ATTACH_SOURCE files = (' || files || ')';
    insert into RAW.ATTACHMENTS (attachment_id, claim_id, file_name, received_at)
    select a.attachment_id, a.claim_id, a.file_name, c.received_at
    from RAW.ATTACHMENTS_SOURCE a join RAW.CLAIMS c on c.claim_id = a.claim_id
    where not exists (select 1 from RAW.ATTACHMENTS x where x.attachment_id = a.attachment_id);
    n_files := sqlrowcount;
    alter stage RAW.INTAKE refresh;
  end if;
  return object_construct('claims', n_claims, 'files', n_files);
end;
$$;

-- One simulator step: advance the clock, land arrivals, run the pipeline. Called by the task and by the UI.
create or replace procedure OPS.SIM_TICK(P_MINUTES int)
returns variant language sql execute as owner as
$$
declare d int; m int; new_m int; st string; landed variant; pipe variant;
begin
  select sim_day, sim_minute, status into :d, :m, :st from OPS.SIM_STATE;
  if (st = 'DAY_END') then return object_construct('status', st); end if;
  new_m := least(600, m + coalesce(:P_MINUTES, 30));
  update OPS.SIM_STATE set sim_minute = :new_m, status = iff(:new_m >= 600, 'DAY_END', status), updated_at = current_timestamp();
  call OPS.SIM_LAND(:d, :new_m) into :landed;
  call CORE.RUN_PIPELINE('SIM_TICK', null) into :pipe;
  return object_construct('sim_day', d, 'sim_minute', new_m, 'landed', landed, 'pipeline', pipe);
end;
$$;

create or replace procedure OPS.SIM_CONTROL(P_ACTION string)
returns variant language sql execute as owner as
$$
declare d int; st string; max_day int;
begin
  select sim_day, status into :d, :st from OPS.SIM_STATE;
  max_day := (select max(sim_day) from RAW.CLAIMS_SOURCE);
  case (upper(:P_ACTION))
    when 'RUN' then
      if (st = 'DAY_END' and d < max_day) then
        update OPS.SIM_STATE set sim_day = sim_day + 1, sim_minute = 0, status = 'RUNNING';
      elseif (st <> 'DAY_END') then
        update OPS.SIM_STATE set status = 'RUNNING';
      end if;
      alter task OPS.T_SIM_TICK resume;
    when 'PAUSE' then
      update OPS.SIM_STATE set status = iff(status = 'RUNNING', 'PAUSED', status);
      alter task OPS.T_SIM_TICK suspend;
    when 'NEXT_DAY' then
      if (d < max_day) then update OPS.SIM_STATE set sim_day = sim_day + 1, sim_minute = 0, status = 'PAUSED'; end if;
    else return object_construct('error', 'unknown action ' || :P_ACTION);
  end case;
  return (select object_construct('sim_day', sim_day, 'sim_minute', sim_minute, 'status', status) from OPS.SIM_STATE);
end;
$$;

create or replace task OPS.T_SIM_TICK
  warehouse = ZELIS_C2C_WH schedule = '1 MINUTE' allow_overlapping_execution = false
  comment = 'Accelerated simulator: 30 business minutes per real minute while RUNNING'
as
  execute immediate $$
  begin
    if ((select status from OPS.SIM_STATE) = 'RUNNING') then
      call OPS.SIM_TICK(30);
      if ((select status from OPS.SIM_STATE) = 'DAY_END') then
        alter task OPS.T_SIM_TICK suspend;
      end if;
    end if;
  end;
  $$;
