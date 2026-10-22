-- 05_ai_layer.sql — Cortex Search corpora, agent tool procedures, semantic view, Cortex Agents.
use role ZELIS_C2C_ROLE;
use warehouse ZELIS_C2C_WH;
use database ZELIS_C2C;

-- ---------------------------------------------------------------- document corpus (contracts + policies)
create table if not exists AI.DOC_CORPUS (relative_path string, doc_kind string, contract_id string, payer_id string,
  org_id string, title string, parsed_text string, parsed_at timestamp_ntz);

insert into AI.DOC_CORPUS
select d.relative_path, iff(startswith(d.relative_path, 'POL_'), 'POLICY', 'CONTRACT'),
  iff(startswith(d.relative_path, 'POL_'), null, split_part(d.relative_path, '.', 1)),
  k.payer_id, k.org_id,
  regexp_substr(p.j:content::string, '^#\\s*([^\\n]+)', 1, 1, 'e'),
  p.j:content::string, current_timestamp()
from directory(@CORE.DOCS) d
join lateral (select parse_json(to_varchar(AI_PARSE_DOCUMENT(TO_FILE('@CORE.DOCS', d.relative_path), {'mode': 'LAYOUT'}))) j) p
left join CORE.CONTRACTS k on k.contract_id = split_part(d.relative_path, '.', 1)
where not exists (select 1 from AI.DOC_CORPUS c where c.relative_path = d.relative_path);

-- Section-aware chunks: split on markdown headers so a citation points at a contract section, not a page.
create or replace table AI.DOC_CHUNKS as
select c.relative_path, c.doc_kind, c.contract_id, c.payer_id, c.org_id, c.title,
  coalesce(s.value:headers:header_2::string, s.value:headers:header_1::string, 'Preamble') section,
  c.relative_path || '#' || lpad(s.index, 2, '0') chunk_id,
  s.value:chunk::string chunk,
  coalesce(c.title, '') || ' | ' || coalesce(s.value:headers:header_2::string, '') || '\n' || s.value:chunk::string search_text
from AI.DOC_CORPUS c,
  lateral flatten(input => SNOWFLAKE.CORTEX.SPLIT_TEXT_MARKDOWN_HEADER(c.parsed_text,
                     object_construct('#', 'header_1', '##', 'header_2'), 1800, 150)) s;

create or replace cortex search service AI.CONTRACT_SEARCH
  on search_text
  attributes contract_id, payer_id, org_id, section
  warehouse = ZELIS_C2C_WH target_lag = '1 day'
  comment = 'Provider contracts, chunked by section'
as select chunk_id, search_text, chunk, title, section, contract_id, payer_id, org_id, relative_path
   from AI.DOC_CHUNKS where doc_kind = 'CONTRACT';

create or replace cortex search service AI.POLICY_SEARCH
  on search_text
  attributes section, title
  warehouse = ZELIS_C2C_WH target_lag = '1 day'
  comment = 'Payer payment, coding, integrity and payment-operations policies'
as select chunk_id, search_text, chunk, title, section, relative_path
   from AI.DOC_CHUNKS where doc_kind = 'POLICY';

-- ---------------------------------------------------------------- agent tools (read-only + propose-only)
-- Everything an agent needs to reason about one exception, in one call.
create or replace procedure AI.TOOL_GET_EXCEPTION_CONTEXT(EXCEPTION_ID string)
returns variant language sql execute as owner as
$$
declare ctx variant;
begin
  ctx := (
    with e as (select * from CORE.EXCEPTIONS where exception_id = :EXCEPTION_ID),
    c as (select c.* from RAW.CLAIMS c join e on e.claim_id = c.claim_id)
    select object_construct(
      'exception', (select object_construct('exception_id', exception_id, 'type', exception_type, 'stage', stage,
                      'rule_id', rule_id, 'rule_version', rule_version, 'rule_title', details:rule_title, 'line_no', line_no,
                      'status', status) from e),
      'allowed_decisions', (select array_agg(object_construct('decision', d.decision, 'label', d.label,
                              'description', d.description)) from CORE.DECISIONS d join e on e.exception_type = d.exception_type),
      'claim', (select object_construct('claim_id', c.claim_id, 'payer_id', c.payer_id, 'payer_name', p.payer_name,
                  'org_id', c.org_id, 'provider_org', o.org_name, 'provider_tin', o.tin, 'network', o.network_kind,
                  'specialty', o.specialty, 'frequency_code', c.frequency_code, 'service_from', c.service_from,
                  'billed_amt', c.billed_amt, 'pay_method', o.pay_method, 'epay_enrolled', o.epay_enrolled)
                from c join CORE.PROVIDER_ORGS o on o.org_id = c.org_id join CORE.PAYERS p on p.payer_id = c.payer_id),
      'current_pricing', (select object_construct('status', s.status, 'allowed_amt', s.allowed_amt,
                            'pricing_status', s.pricing_status, 'snapshot', s.pricing_snapshot)
                          from CORE.CLAIM_STATE s join e on e.claim_id = s.claim_id),
      'contract', (select object_construct('contract_id', k.contract_id, 'pct_of_base', k.pct_of_base,
                     'stop_loss_threshold', k.stop_loss_threshold, 'stop_loss_pct', k.stop_loss_pct,
                     'carveouts', (select array_agg(object_construct('code', cv.code, 'rate_type', cv.rate_type, 'rate', cv.rate,
                                     'pct', cv.pct, 'markup_pct', cv.markup_pct, 'cap_mult', cv.cap_mult,
                                     'source_section', cv.source_section)) from CORE.CONTRACT_CARVEOUTS cv
                                   where cv.contract_id = k.contract_id))
                   from CORE.CLAIM_STATE s join e on e.claim_id = s.claim_id
                   join CORE.CONTRACTS k on k.contract_id = s.pricing_snapshot:contract_id::string),
      'documents', (select array_agg(object_construct('attachment_id', d.attachment_id, 'doc_type', d.doc_type,
                      'fields', d.fields, 'scores', d.scores, 'status', d.status,
                      'text', left(d.parsed_text, 2500)))
                    from AI.DOC_EXTRACTS d join e on e.claim_id = d.claim_id),
      'duplicate_of', (select object_construct('claim_id', dc.claim_id, 'frequency_code', dc.frequency_code,
                         'billed_amt', dc.billed_amt, 'received_at', dc.received_at, 'status', ds.status,
                         'allowed_amt', ds.allowed_amt)
                       from CORE.V_DUPLICATES v join e on e.claim_id = v.claim_id
                       join RAW.CLAIMS dc on dc.claim_id = v.first_claim_id
                       join CORE.CLAIM_STATE ds on ds.claim_id = dc.claim_id),
      'edit_pair', (select object_construct('column1_code', h.column1_code, 'column2_code', h.column2_code,
                      'column1_line_no', h.column1_line_no, 'component_line_no', h.line_no)
                    from CORE.V_EDIT_HITS h join e on e.claim_id = h.claim_id and h.line_no = e.line_no),
      'bank', (select object_construct('current', object_construct('bank_name', b.bank_name, 'bank_state', b.bank_state,
                  'effective_from', b.effective_from, 'change_source', b.change_source, 'verified', b.verified,
                  'days_since_change', b.days_since_change, 'hold_required', b.hold_required),
                  'history', (select array_agg(object_construct('bank_name', h.bank_name, 'bank_state', h.bank_state,
                                'effective_from', h.effective_from, 'effective_to', h.effective_to,
                                'change_source', h.change_source, 'verified', h.verified)) within group (order by h.effective_from)
                              from CORE.BANK_ACCOUNTS h where h.org_id = b.org_id))
               from c join CORE.V_BANK_STATUS b on b.org_id = c.org_id),
      'provider_profile', (select object_construct('claims_received', count(*), 'em_level5_share',
                             round(count_if(l.code = '99215') / nullif(count_if(l.code in ('99212','99213','99214','99215')), 0), 3))
                           from RAW.CLAIMS x join RAW.CLAIM_LINES l on l.claim_id = x.claim_id
                           join c on c.org_id = x.org_id)
    ));
  if (ctx:exception is null) then return object_construct('error', 'unknown exception_id ' || :EXCEPTION_ID); end if;
  return ctx;
end;
$$;

-- What-if pricing for a decision. The agent names a decision; the engine supplies every number.
create or replace procedure AI.TOOL_REPRICE_DECISION(EXCEPTION_ID string, DECISION string)
returns variant language sql execute as owner as
$$
declare claim string; line_no int; exc_type string; n int; dup_of string; adj array; dry variant; cur number(18,2);
begin
  select claim_id, coalesce(line_no, 1), exception_type into :claim, :line_no, :exc_type
    from CORE.EXCEPTIONS where exception_id = :EXCEPTION_ID;
  if (claim is null) then return object_construct('error', 'unknown exception_id'); end if;
  n := (select count(*) from CORE.DECISIONS where exception_type = :exc_type and decision = upper(:DECISION));
  if (n = 0) then
    return object_construct('error', 'decision not allowed for ' || exc_type,
      'allowed', (select array_agg(decision) from CORE.DECISIONS where exception_type = :exc_type));
  end if;
  dup_of := (select first_claim_id from CORE.V_DUPLICATES where claim_id = :claim);
  adj := CORE.DECISION_TO_ADJ(upper(:DECISION), :line_no, :dup_of, null);
  call CORE.REPRICE_DRY_RUN(:claim, :adj) into :dry;
  cur := (select allowed_amt from CORE.CLAIM_STATE where claim_id = :claim);
  return object_construct('decision', upper(DECISION), 'adjustments', adj, 'current_allowed_amt', cur,
    'proposed_allowed_amt', dry:allowed_amt, 'delta', dry:allowed_amt::number(18,2) - cur, 'result', dry);
end;
$$;

-- Propose-only. Citations and risk flags arrive as JSON strings (agent tools cannot take OBJECT parameters).
create or replace procedure AI.TOOL_SUBMIT_PROPOSAL(EXCEPTION_ID string, DECISION string, RATIONALE string,
  CITATIONS_JSON string, CONFIDENCE float, RISK_FLAGS_JSON string, AGENT_NAME string, CORRELATION_ID string)
returns variant language sql execute as owner as
$$
declare res variant; prop variant; cits variant; flags variant;
begin
  cits := try_parse_json(:CITATIONS_JSON);
  flags := try_parse_json(:RISK_FLAGS_JSON);
  prop := object_construct('decision', :DECISION, 'rationale', :RATIONALE,
    'citations', iff(is_array(cits), cits, iff(cits is null, null, array_construct(cits))),
    'confidence', :CONFIDENCE, 'risk_flags', iff(is_array(flags), flags, array_construct()),
    'citations_raw', iff(cits is null, :CITATIONS_JSON, null));
  call AI.SUBMIT_PROPOSAL(:EXCEPTION_ID, :prop, coalesce(:AGENT_NAME, 'UNKNOWN_AGENT'), :CORRELATION_ID) into :res;
  return res;
end;
$$;

-- ---------------------------------------------------------------- semantic view (Cortex Analyst)
create or replace view APP.V_CLAIMS_ANALYTIC as
select c.claim_id, c.payer_id, p.payer_name, c.org_id, o.org_name provider_org, o.specialty, o.network_kind,
  c.claim_type, c.service_from, c.sim_day, c.received_at received_sim_ts, c.billed_amt, s.allowed_amt, s.payable_amt,
  s.status claim_status, s.pay_method, s.same_day_eligible, s.batch_id, s.ready_sim_ts, s.released_sim_ts,
  datediff(minute, c.received_at, s.ready_sim_ts) minutes_to_ready,
  iff(s.ready_sim_ts is not null and to_date(s.ready_sim_ts) = to_date(c.received_at), 1, 0) ready_same_day_flag,
  (s.ready_sim_ts is not null and to_date(s.ready_sim_ts) = to_date(c.received_at)) ready_same_day,
  coalesce(x.n, 0) exception_count, iff(coalesce(x.n, 0) = 0, 1, 0) stp_flag
from RAW.CLAIMS c join CORE.CLAIM_STATE s on s.claim_id = c.claim_id
join CORE.PROVIDER_ORGS o on o.org_id = c.org_id join CORE.PAYERS p on p.payer_id = c.payer_id
left join (select claim_id, count(*) n from CORE.EXCEPTIONS group by 1) x on x.claim_id = c.claim_id;

create or replace view APP.V_EXCEPTIONS_ANALYTIC as
select e.exception_id, e.claim_id, e.stage, e.exception_type, e.rule_id, e.status exception_status, e.owner_persona,
  e.opened_sim_ts, e.resolved_sim_ts, datediff(minute, e.opened_sim_ts, e.resolved_sim_ts) minutes_to_resolve,
  e.resolution:decision::string decision, e.resolution:agreed_with_agent::boolean agreed_with_agent,
  iff(e.resolution:agreed_with_agent::boolean, 1, 0) agreed_flag, iff(e.resolution:agreed_with_agent is not null, 1, 0) had_proposal_flag,
  c.payer_id, c.billed_amt
from CORE.EXCEPTIONS e join RAW.CLAIMS c on c.claim_id = e.claim_id;

create or replace semantic view APP.C2C_SV
  tables (
    claims as APP.V_CLAIMS_ANALYTIC primary key (claim_id)
      with synonyms = ('claim', 'claims') comment = 'One row per received claim with pricing and payment status',
    exceptions as APP.V_EXCEPTIONS_ANALYTIC primary key (exception_id)
      with synonyms = ('exception', 'pend', 'review item') comment = 'Exceptions raised by pricing, integrity and payment rules',
    batches as CORE.PAYMENT_BATCHES primary key (batch_id)
      with synonyms = ('payment batch', 'payment run') comment = 'Payment batches by payer and payment method'
  )
  relationships (
    exceptions_to_claims as exceptions (claim_id) references claims,
    claims_to_batches as claims (batch_id) references batches
  )
  facts (
    claims.billed as billed_amt comment = 'Billed charges in USD',
    claims.allowed as allowed_amt comment = 'Allowed amount in USD from the pricing engine',
    claims.payable as payable_amt comment = 'Amount payable to the provider in USD',
    claims.minutes_to_ready as minutes_to_ready comment = 'Simulated business minutes from receipt to payment-ready',
    claims.stp_flag as stp_flag comment = '1 when the claim needed no review',
    claims.ready_same_day_flag as ready_same_day_flag comment = '1 when payment-ready the same business day',
    exceptions.minutes_to_resolve as minutes_to_resolve comment = 'Simulated business minutes from opened to resolved',
    exceptions.agreed_flag as agreed_flag,
    exceptions.had_proposal_flag as had_proposal_flag,
    batches.batch_total as total_amt comment = 'Batch total in USD'
  )
  dimensions (
    claims.payer_name as payer_name with synonyms = ('payer', 'health plan', 'client'),
    claims.provider_org as provider_org with synonyms = ('provider', 'practice', 'facility'),
    claims.specialty as specialty,
    claims.network_kind as network_kind comment = 'CONTRACTED, SOLO_PAR (standard participation) or SOLO_OON (out of network)',
    claims.claim_status as claim_status comment = 'RECEIVED, EXCEPTION, READY, BATCHED, RELEASED, DENIED, HELD, OFFER_PENDING',
    claims.pay_method as pay_method comment = 'ACH, VCARD or CHECK',
    claims.same_day_eligible as same_day_eligible comment = 'Provider is enrolled in electronic payment (ACH or virtual card)',
    claims.ready_same_day as ready_same_day comment = 'Claim became payment-ready on the business day it was received',
    claims.sim_day as sim_day comment = 'Simulated business day number (1, 2, 3)',
    claims.service_from as service_from,
    exceptions.stage as stage comment = 'PRICING, INTEGRITY or PAYMENT',
    exceptions.exception_type as exception_type,
    exceptions.exception_status as exception_status comment = 'NEW, AGENT_PROPOSED, RESOLVED, ESCALATED',
    exceptions.decision as decision,
    exceptions.agreed_with_agent as agreed_with_agent comment = 'Human decision matched the agent proposal',
    batches.batch_pay_method as pay_method,
    batches.batch_status as status comment = 'DRAFT, APPROVED, RELEASED'
  )
  metrics (
    claims.claim_count as count(claims.claim_id),
    claims.total_billed as sum(claims.billed),
    claims.total_allowed as sum(claims.allowed),
    claims.total_payable as sum(claims.payable),
    claims.straight_through_rate as sum(claims.stp_flag) / nullif(count(claims.claim_id), 0)
      comment = 'Share of claims that needed no human or agent review',
    claims.same_day_ready_rate as sum(claims.ready_same_day_flag) / nullif(count(claims.claim_id), 0)
      comment = 'Share of claims payment-ready the same business day they were received',
    claims.avg_minutes_to_ready as avg(claims.minutes_to_ready),
    exceptions.exception_count as count(exceptions.exception_id),
    exceptions.avg_minutes_to_resolve as avg(exceptions.minutes_to_resolve),
    exceptions.agent_agreement_rate as sum(exceptions.agreed_flag) / nullif(sum(exceptions.had_proposal_flag), 0)
      comment = 'Share of resolved exceptions where the reviewer accepted the agent proposal',
    batches.batch_count as count(batches.batch_id),
    batches.total_batched as sum(batches.batch_total)
  )
  comment = 'Zelis Claim-to-Cash operations: claims, exceptions and payment batches (synthetic data)';
