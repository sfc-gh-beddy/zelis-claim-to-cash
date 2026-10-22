-- 02_engine.sql — deterministic pricing engine + rule features.
--
-- Design: one engine, many scenarios. Adjustments (human-approved corrections such as "add modifier 50",
-- "deny line 2", "use Exhibit A rate") live in CORE.CLAIM_ADJUSTMENTS with scenario_id = 'LIVE'.
-- A dry-run (used by agents and the UI "what would this pay?") inserts draft adjustments under a throwaway
-- scenario_id and runs the same procedure. The LLM never computes an amount.
--
-- Execution shape: CORE.PRICE_WORK materialises each stage into run-keyed transient tables
-- (input -> lines -> claims -> rule features). A stacked-view version compiled for ~17s per reference;
-- staged statements compile in about a second each.
--
-- Mirrors datagen/pricing_spec.py exactly; sql/tests/01_pricing_vs_truth.sql asserts cent-level agreement.
use role ZELIS_C2C_ROLE;
use warehouse ZELIS_C2C_WH;
use database ZELIS_C2C;

drop view if exists CORE.V_RULE_FEATURES;
drop view if exists CORE.V_PRICED_CLAIMS;
drop view if exists CORE.V_PRICED_LINES;
drop view if exists CORE.V_PRICE_INPUT;
drop view if exists CORE.V_ADJ;
drop view if exists CORE.V_SCENARIOS;

-- ---------------------------------------------------------------- simulation clock
create table if not exists OPS.SIM_STATE (
  id int default 1, sim_start date not null, sim_day int not null, sim_minute int not null, status string not null,
  minutes_per_tick int not null, updated_at timestamp_ntz default current_timestamp());
merge into OPS.SIM_STATE t using (select 1 id) s on t.id = s.id
  when not matched then insert (id, sim_start, sim_day, sim_minute, status, minutes_per_tick)
  values (1, '2026-10-26', 1, 0, 'PAUSED', 30);

-- Simulated business clock: day N starts 08:00, 600 business minutes per day.
create or replace function OPS.SIM_NOW() returns timestamp_ntz as
$$ select dateadd(minute, 480 + sim_minute, dateadd(day, sim_day - 1, sim_start)::timestamp_ntz) from OPS.SIM_STATE $$;
create or replace function OPS.SIM_DATE() returns date as
$$ select dateadd(day, sim_day - 1, sim_start) from OPS.SIM_STATE $$;

-- ---------------------------------------------------------------- adjustments (append-only; latest per key wins)
create table if not exists CORE.CLAIM_ADJUSTMENTS (
  adjustment_id string default uuid_string(), scenario_id string not null default 'LIVE', claim_id string not null,
  line_no int not null default 0, action string not null, value_str string, value_num number(18,2),
  source_exception_id string, created_by string, created_at timestamp_ntz default current_timestamp());
-- Actions:  claim (line_no 0): DENY_CLAIM, VOID_CLAIM, STOP_LOSS_NONCOVERED(value_num), PAYMENT_HOLD,
--                              REPLACES_CLAIM(value_str = original claim_id)
--           line:              DENY_LINE, RECODE(value_str), ADD_MODIFIER(value_str), INVOICE_COST(value_num),
--                              CARVEOUT_SOURCE(value_str)

-- ---------------------------------------------------------------- document facts (filled by intake, 03)
create table if not exists AI.DOC_EXTRACTS (
  attachment_id string, claim_id string, file_name string, doc_type string, page_count int, parsed_text string,
  fields variant, scores variant, min_score float, status string, error string,
  parsed_at timestamp_ntz, extracted_at timestamp_ntz);
alter table AI.DOC_EXTRACTS add column if not exists attempts int;

-- Money-bearing facts are only usable when the extraction score clears the gate (0.85).
create or replace view AI.V_CLAIM_DOC_FACTS as
select claim_id,
  max(iff(doc_type = 'implant_invoice' and scores:invoice_total:score::float >= 0.85,
          try_to_number(regexp_replace(fields:invoice_total::string, '[$, ]', ''), 18, 2), null)) invoice_total,
  max(iff(doc_type = 'implant_invoice', scores:invoice_total:score::float, null))                  invoice_total_score,
  max(iff(doc_type = 'itemized_bill' and scores:total_non_covered:score::float >= 0.85,
          try_to_number(regexp_replace(fields:total_non_covered::string, '[$, ]', ''), 18, 2), null)) non_covered,
  max(iff(doc_type = 'itemized_bill', scores:total_non_covered:score::float, null))                non_covered_score,
  max(iff(doc_type = 'operative_note', lower(fields:laterality::string), null))                     laterality,
  max(iff(doc_type = 'bank_change_letter', fields, null))                                           bank_letter,
  array_agg(distinct doc_type)                                                                      doc_types
from AI.DOC_EXTRACTS where status in ('OK', 'LOW_CONFIDENCE')
group by claim_id;

-- ---------------------------------------------------------------- small feature views (single level)
create or replace view CORE.V_CLAIM_SIGNATURE as
select c.claim_id, c.org_id, c.member_id, c.service_from, c.received_at, c.frequency_code,
  c.org_id || '|' || c.member_id || '|' || c.service_from || '|' || listagg(l.code, ',') within group (order by l.code, l.line_no) sig
from RAW.CLAIMS c join RAW.CLAIM_LINES l on l.claim_id = c.claim_id
group by 1, 2, 3, 4, 5, 6;

create or replace view CORE.V_DUPLICATES as
select claim_id, sig, first_value(claim_id) over (partition by sig order by received_at, claim_id) first_claim_id
from CORE.V_CLAIM_SIGNATURE
qualify first_claim_id <> claim_id;

create or replace view CORE.V_EDIT_HITS as
select l2.claim_id, l2.line_no, l1.line_no column1_line_no, l1.code column1_code, l2.code column2_code
from RAW.CLAIM_LINES l2
join CORE.EDIT_PAIRS ep on ep.column2_code = l2.code
join RAW.CLAIM_LINES l1 on l1.claim_id = l2.claim_id and l1.code = ep.column1_code
where not arrays_overlap(l2.modifiers, split(ep.bypass_modifiers, ','));

create or replace view CORE.V_BANK_STATUS as
select b.org_id, b.bank_account_id, b.bank_name, b.bank_state, b.routing_last4, b.account_last4, b.effective_from,
  b.change_source, b.verified, datediff(day, b.effective_from, OPS.SIM_DATE()) days_since_change,
  (not b.verified and b.change_source in ('LETTER', 'PHONE') and datediff(day, b.effective_from, OPS.SIM_DATE()) <= 7) hold_required
from CORE.BANK_ACCOUNTS b
where b.effective_from <= OPS.SIM_DATE() and (b.effective_to is null or b.effective_to > OPS.SIM_DATE())
qualify row_number() over (partition by b.org_id order by b.effective_from desc) = 1;

-- ---------------------------------------------------------------- staged work tables
create transient table if not exists CORE.PIPELINE_WORK (run_id string, claim_id string);

create or replace transient table CORE.W_PRICE_INPUT (
  run_id string, scenario_id string, claim_id string, payer_id string, org_id string, claim_billed number(18,2),
  frequency_code string, network_kind string, line_no int, billed_code string, billed_mods array, units int,
  line_billed number(18,2), eff_code string, eff_mods array, deny_line boolean, adj_invoice number(18,2),
  carve_source string, claim_denial string, adj_noncovered number(18,2), payment_hold boolean,
  contract_id string, pct_of_base number(5,2), stop_loss_threshold number(18,2), stop_loss_pct number(5,2),
  oon_pct number(5,2), oon_review_threshold number(18,2), oon_negotiate_threshold number(18,2));

create or replace transient table CORE.W_PRICED_LINES (
  run_id string, scenario_id string, claim_id string, line_no int, billed_code string, eff_code string,
  billed_mods array, eff_mods array, units int, units_eff int, line_billed number(18,2), base_rate number(18,2),
  modifier_factor number(12,6), bilateral_eligible boolean, category string, contract_id string, n_carve int,
  carveout variant, invoice_cost number(18,2), invoice_source string, price_method string, pct_applied number(5,2),
  line_allowed number(18,2));

create or replace transient table CORE.W_PRICED_CLAIMS (
  run_id string, scenario_id string, claim_id string, payer_id string, org_id string, contract_id string,
  network_kind string, claim_billed number(18,2), claim_denial string, payment_hold boolean, stop_loss_applies boolean,
  non_covered number(18,2), non_covered_source string, pricing_status string, unresolved_reasons array,
  allowed_amt number(18,2), lines_allowed number(18,2), capped_at_billed boolean);

create or replace transient table CORE.W_RULE_FEATURES (
  run_id string, claim_id string, line_no int, eff_code string, eff_mods array, units int, bilateral_eligible boolean,
  category string, price_method string, contract_id string, payer_id string, org_id string, frequency_code string,
  claim_type string, claim_billed number(18,2), pricing_status string, stop_loss_applies boolean, network_kind string,
  specialty string, stop_loss_threshold number(18,2), oon_review_threshold number(18,2),
  oon_negotiate_threshold number(18,2), dup_of_claim_id string, edit_pair_component boolean, column1_code string,
  em_prepay_review boolean, bank_change_hold boolean, bank_days_since_change int);

-- ---------------------------------------------------------------- the engine
-- Prices every claim in CORE.PIPELINE_WORK for P_RUN_ID under scenario P_SCENARIO ('LIVE' or a draft id whose
-- CLAIM_ADJUSTMENTS rows override LIVE ones). Leaves results in W_PRICED_LINES / W_PRICED_CLAIMS /
-- W_RULE_FEATURES for the caller, which deletes them with CORE.CLEAR_WORK.
create or replace procedure CORE.PRICE_WORK(P_RUN_ID string, P_SCENARIO string)
returns int language sql execute as owner as
$$
begin
  insert into CORE.W_PRICE_INPUT
  with adj as (
    select a.claim_id, a.line_no, a.action, a.value_str, a.value_num
    from CORE.CLAIM_ADJUSTMENTS a join CORE.PIPELINE_WORK w on w.claim_id = a.claim_id and w.run_id = :P_RUN_ID
    where a.scenario_id in ('LIVE', :P_SCENARIO)
    qualify row_number() over (partition by a.claim_id, a.line_no, a.action
                               order by iff(a.scenario_id = 'LIVE', 0, 1) desc, a.created_at desc) = 1),
  claim_adj as (
    select claim_id,
      max(iff(action in ('DENY_CLAIM', 'VOID_CLAIM'), action, null)) claim_denial,
      max(iff(action = 'STOP_LOSS_NONCOVERED', value_num, null))     adj_noncovered,
      max(iff(action = 'PAYMENT_HOLD', true, null))                  payment_hold
    from adj where line_no = 0 group by 1),
  line_adj as (
    select claim_id, line_no,
      max(iff(action = 'DENY_LINE', true, null))            deny_line,
      max(iff(action = 'RECODE', value_str, null))          recode,
      max(iff(action = 'ADD_MODIFIER', value_str, null))    add_mod,
      max(iff(action = 'INVOICE_COST', value_num, null))    adj_invoice,
      max(iff(action = 'CARVEOUT_SOURCE', value_str, null)) carve_source
    from adj where line_no > 0 group by 1, 2)
  select :P_RUN_ID, :P_SCENARIO, c.claim_id, c.payer_id, c.org_id, c.billed_amt, c.frequency_code, o.network_kind,
    l.line_no, l.code, l.modifiers, l.units, l.billed_amt,
    coalesce(la.recode, l.code),
    iff(la.add_mod is null or array_contains(la.add_mod::variant, l.modifiers), l.modifiers, array_append(l.modifiers, la.add_mod)),
    coalesce(la.deny_line, false), la.adj_invoice, la.carve_source,
    ca.claim_denial, ca.adj_noncovered, coalesce(ca.payment_hold, false),
    k.contract_id, k.pct_of_base, k.stop_loss_threshold, k.stop_loss_pct,
    p.oon_pct, p.oon_review_threshold, p.oon_negotiate_threshold
  from CORE.PIPELINE_WORK w
  join RAW.CLAIMS c on c.claim_id = w.claim_id
  join RAW.CLAIM_LINES l on l.claim_id = c.claim_id
  join CORE.PROVIDER_ORGS o on o.org_id = c.org_id
  join CORE.PAYERS p on p.payer_id = c.payer_id
  left join CORE.CONTRACTS k on k.payer_id = c.payer_id and (
        (o.network_kind = 'CONTRACTED' and k.org_id = c.org_id)
     or (o.network_kind = 'SOLO_PAR' and k.contract_kind = 'STANDARD'))
  left join line_adj la on la.claim_id = c.claim_id and la.line_no = l.line_no
  left join claim_adj ca on ca.claim_id = c.claim_id
  where w.run_id = :P_RUN_ID;

  insert into CORE.W_PRICED_LINES
  with i as (select * from CORE.W_PRICE_INPUT where run_id = :P_RUN_ID),
  mods_flat as (
    select i.claim_id, i.line_no, f.value::string modifier
    from i, lateral flatten(input => i.eff_mods, outer => true) f),
  modf as (
    -- product of modifier factors; factors have <= 2 decimals so rounding exp(sum(ln)) to 6 dp is exact
    select mf.claim_id, mf.line_no, round(exp(sum(ln(coalesce(m.factor, 1)))), 6)::number(12, 6) factor
    from mods_flat mf left join CORE.MODIFIER_FACTORS m on m.modifier = mf.modifier
    group by 1, 2),
  carve as (
    select i.claim_id, i.line_no, count(cv.code) n_carve, count_if(cv.source_section = i.carve_source) n_chosen,
      -- the unique carve-out, or the one chosen by a CARVEOUT_SOURCE adjustment
      max_by(object_construct('rate_type', cv.rate_type, 'rate', cv.rate, 'pct', cv.pct, 'markup_pct', cv.markup_pct,
                              'cap_mult', cv.cap_mult, 'source', cv.source_section),
             iff(cv.source_section = i.carve_source, 2, 1)) best
    from i join CORE.CONTRACT_CARVEOUTS cv on cv.contract_id = i.contract_id and cv.code = i.eff_code
    group by 1, 2),
  b as (
    select i.*, fs.base_rate, fs.bilateral_eligible, fs.category, mf.factor modifier_factor,
      coalesce(cr.n_carve, 0) n_carve, iff(cr.n_carve = 1 or cr.n_chosen = 1, cr.best, null) carveout,
      iff(array_contains('50'::variant, i.eff_mods), 1, i.units) units_eff,
      coalesce(i.adj_invoice, df.invoice_total) invoice_cost,
      iff(i.adj_invoice is not null, 'ADJUSTMENT', iff(df.invoice_total is not null, 'DOC_EXTRACT', null)) invoice_source
    from i
    join CORE.FEE_SCHEDULE fs on fs.code = i.eff_code
    join modf mf on mf.claim_id = i.claim_id and mf.line_no = i.line_no
    left join carve cr on cr.claim_id = i.claim_id and cr.line_no = i.line_no
    left join AI.V_CLAIM_DOC_FACTS df on df.claim_id = i.claim_id),
  m as (
    select b.*,
      case
        when b.claim_denial is not null or b.deny_line then 'DENIED'
        when b.n_carve > 1 and b.carveout is null then 'CARVEOUT_CONFLICT'
        when b.carveout:rate_type::string = 'FLAT' then 'CARVE_FLAT'
        when b.carveout:rate_type::string = 'PCT_OVERRIDE' then 'CARVE_PCT'
        when b.carveout:rate_type::string = 'INVOICE_PLUS' then iff(b.invoice_cost is null, 'NEEDS_INVOICE', 'CARVE_INVOICE_PLUS')
        when b.contract_id is null then 'OON_POLICY'
        else 'CONTRACT_PCT' end price_method
    from b)
  select :P_RUN_ID, :P_SCENARIO, m.claim_id, m.line_no, m.billed_code, m.eff_code, m.billed_mods, m.eff_mods, m.units,
    m.units_eff, m.line_billed, m.base_rate, m.modifier_factor, m.bilateral_eligible, m.category, m.contract_id,
    m.n_carve, m.carveout, m.invoice_cost, m.invoice_source, m.price_method,
    case m.price_method when 'CARVE_PCT' then m.carveout:pct::number(5, 2) when 'OON_POLICY' then m.oon_pct
         when 'CONTRACT_PCT' then m.pct_of_base end,
    case m.price_method
      when 'DENIED' then 0
      when 'CARVE_FLAT' then round(m.carveout:rate::number(18, 2) * m.units, 2)
      when 'CARVE_INVOICE_PLUS' then round(least(m.invoice_cost * (1 + m.carveout:markup_pct::number(5, 2) / 100),
                                                 m.base_rate * m.carveout:cap_mult::number(6, 2) * m.units), 2)
      when 'CARVE_PCT' then round(m.base_rate * m.units_eff * m.modifier_factor * m.carveout:pct::number(5, 2) / 100, 2)
      when 'OON_POLICY' then round(m.base_rate * m.units_eff * m.modifier_factor * m.oon_pct / 100, 2)
      when 'CONTRACT_PCT' then round(m.base_rate * m.units_eff * m.modifier_factor * m.pct_of_base / 100, 2)
    end
  from m;

  insert into CORE.W_PRICED_CLAIMS
  with agg as (
    select claim_id, sum(line_allowed) lines_allowed, count_if(line_allowed is null) unresolved_lines,
      array_agg(distinct iff(line_allowed is null, price_method, null)) unresolved_reasons
    from CORE.W_PRICED_LINES where run_id = :P_RUN_ID group by 1),
  hdr as (
    select distinct claim_id, payer_id, org_id, claim_billed, claim_denial, adj_noncovered, payment_hold,
      contract_id, stop_loss_threshold, stop_loss_pct, network_kind
    from CORE.W_PRICE_INPUT where run_id = :P_RUN_ID),
  sl as (
    select h.*, a.lines_allowed, a.unresolved_lines, a.unresolved_reasons,
      (h.stop_loss_threshold is not null and h.claim_billed > h.stop_loss_threshold and h.claim_denial is null) stop_loss_applies,
      coalesce(h.adj_noncovered, df.non_covered) non_covered,
      iff(h.adj_noncovered is not null, 'ADJUSTMENT', iff(df.non_covered is not null, 'DOC_EXTRACT', null)) non_covered_source
    from hdr h join agg a on a.claim_id = h.claim_id
    left join AI.V_CLAIM_DOC_FACTS df on df.claim_id = h.claim_id)
  select :P_RUN_ID, :P_SCENARIO, claim_id, payer_id, org_id, contract_id, network_kind, claim_billed, claim_denial,
    payment_hold, stop_loss_applies, non_covered, non_covered_source,
    case when claim_denial is not null then 'DENIED'
         when stop_loss_applies then iff(non_covered is null, 'NEEDS_ITEMIZED', 'STOP_LOSS')
         when unresolved_lines > 0 then 'INCOMPLETE'
         else 'PRICED' end,
    iff(stop_loss_applies and non_covered is null, array_append(unresolved_reasons, 'NEEDS_ITEMIZED'), unresolved_reasons),
    case when claim_denial is not null then 0
         when stop_loss_applies then iff(non_covered is null, null,
              least(round((claim_billed - non_covered) * stop_loss_pct / 100, 2), claim_billed))
         when unresolved_lines > 0 then null
         else least(lines_allowed, claim_billed) end,
    lines_allowed, (lines_allowed > claim_billed)
  from sl;

  insert into CORE.W_RULE_FEATURES
  select :P_RUN_ID, pl.claim_id, pl.line_no, pl.eff_code, pl.eff_mods, pl.units, pl.bilateral_eligible, pl.category,
    pl.price_method, pl.contract_id, c.payer_id, c.org_id, c.frequency_code, c.claim_type,
    pc.claim_billed, pc.pricing_status, pc.stop_loss_applies, o.network_kind, o.specialty,
    k.stop_loss_threshold, p.oon_review_threshold, p.oon_negotiate_threshold,
    d.first_claim_id, (eh.claim_id is not null), eh.column1_code,
    coalesce(o.em_outlier, false), coalesce(bs.hold_required, false), bs.days_since_change
  from CORE.W_PRICED_LINES pl
  join CORE.W_PRICED_CLAIMS pc on pc.run_id = pl.run_id and pc.claim_id = pl.claim_id
  join RAW.CLAIMS c on c.claim_id = pl.claim_id
  join CORE.PROVIDER_ORGS o on o.org_id = c.org_id
  join CORE.PAYERS p on p.payer_id = c.payer_id
  left join CORE.CONTRACTS k on k.contract_id = pl.contract_id
  left join CORE.V_DUPLICATES d on d.claim_id = pl.claim_id
  left join CORE.V_EDIT_HITS eh on eh.claim_id = pl.claim_id and eh.line_no = pl.line_no
  left join CORE.V_BANK_STATUS bs on bs.org_id = c.org_id
  where pl.run_id = :P_RUN_ID;

  return (select count(*) from CORE.W_PRICED_CLAIMS where run_id = :P_RUN_ID);
end;
$$;

create or replace procedure CORE.CLEAR_WORK(P_RUN_ID string)
returns int language sql execute as owner as
$$
begin
  delete from CORE.W_PRICE_INPUT where run_id = :P_RUN_ID;
  delete from CORE.W_PRICED_LINES where run_id = :P_RUN_ID;
  delete from CORE.W_PRICED_CLAIMS where run_id = :P_RUN_ID;
  delete from CORE.W_RULE_FEATURES where run_id = :P_RUN_ID;
  delete from CORE.PIPELINE_WORK where run_id = :P_RUN_ID;
  return 0;
end;
$$;

-- What-if pricing for one claim. P_ADJUSTMENTS is an array of {line_no, action, value_str?, value_num?}.
-- Nothing persists: the draft adjustments and work rows are removed before returning.
-- This is the only way an agent (or a person) gets a dollar figure for a proposed resolution.
create or replace procedure CORE.REPRICE_DRY_RUN(P_CLAIM_ID string, P_ADJUSTMENTS variant)
returns variant language sql execute as owner as
$$
declare run_id string default 'DRY-' || uuid_string(); result variant; bad int;
begin
  bad := (select count(*) from table(flatten(input => coalesce(:P_ADJUSTMENTS, [])))
          where value:action::string not in ('DENY_CLAIM', 'VOID_CLAIM', 'STOP_LOSS_NONCOVERED', 'PAYMENT_HOLD',
                 'DENY_LINE', 'RECODE', 'ADD_MODIFIER', 'INVOICE_COST', 'CARVEOUT_SOURCE', 'REPLACES_CLAIM'));
  if (bad > 0) then return object_construct('error', 'unsupported adjustment action'); end if;
  insert into CORE.CLAIM_ADJUSTMENTS (scenario_id, claim_id, line_no, action, value_str, value_num, created_by)
    select :run_id, :P_CLAIM_ID, coalesce(value:line_no::int, 0), value:action::string, value:value_str::string,
           value:value_num::number(18, 2), 'dry_run'
    from table(flatten(input => coalesce(:P_ADJUSTMENTS, [])));
  insert into CORE.PIPELINE_WORK values (:run_id, :P_CLAIM_ID);
  call CORE.PRICE_WORK(:run_id, :run_id);
  result := (
    select object_construct('claim_id', pc.claim_id, 'allowed_amt', pc.allowed_amt, 'pricing_status', pc.pricing_status,
      'claim_billed', pc.claim_billed, 'stop_loss_applies', pc.stop_loss_applies, 'non_covered', pc.non_covered,
      'capped_at_billed', pc.capped_at_billed, 'contract_id', pc.contract_id,
      'lines', (select array_agg(object_construct('line_no', line_no, 'code', eff_code, 'mods', eff_mods, 'units', units,
                        'method', price_method, 'pct', pct_applied, 'base_rate', base_rate,
                        'modifier_factor', modifier_factor, 'invoice_cost', invoice_cost, 'allowed', line_allowed))
                        within group (order by line_no) from CORE.W_PRICED_LINES where run_id = :run_id))
    from CORE.W_PRICED_CLAIMS pc where pc.run_id = :run_id);
  delete from CORE.CLAIM_ADJUSTMENTS where scenario_id = :run_id;
  call CORE.CLEAR_WORK(:run_id);
  return result;
end;
$$;
