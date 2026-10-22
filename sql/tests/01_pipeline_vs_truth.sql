-- tests/01_pipeline_vs_truth.sql — run after a full simulated run (all days landed and priced).
-- Each query returns a PASS/FAIL row plus the evidence. OPS.GROUND_TRUTH is read only here and in evals.
use role ZELIS_C2C_ROLE;
use warehouse ZELIS_C2C_WH;
use database ZELIS_C2C;

-- T1: straight-through claims price to the cent
with stp as (
  select t.claim_id, t.expected_allowed_amt, s.allowed_amt, s.status
  from OPS.GROUND_TRUTH t join CORE.CLAIM_STATE s on s.claim_id = t.claim_id
  where t.expected_route = 'STP')
select 'T1 STP pricing exact to the cent' test,
  iff(count_if(allowed_amt is distinct from expected_allowed_amt) = 0, 'PASS', 'FAIL') result,
  count(*) n, count_if(allowed_amt = expected_allowed_amt) exact,
  count_if(allowed_amt is distinct from expected_allowed_amt) mismatched,
  sum(expected_allowed_amt) expected_total, sum(allowed_amt) actual_total
from stp;

-- T2: routing — every planted exception routed to the right stage, every STP claim untouched
with actual as (
  select s.claim_id,
    coalesce(min_by(e.stage, decode(e.stage, 'PRICING', 1, 'INTEGRITY', 2, 'PAYMENT', 3)), 'STP') actual_route,
    array_agg(distinct e.exception_type) actual_types
  from CORE.CLAIM_STATE s left join CORE.EXCEPTIONS e on e.claim_id = s.claim_id
  group by s.claim_id)
select 'T2 routing confusion' test, t.expected_route, a.actual_route, count(*) n,
  iff(t.expected_route = a.actual_route, 'OK', 'MISROUTE') result
from OPS.GROUND_TRUTH t join actual a on a.claim_id = t.claim_id
group by 2, 3 order by 2, 3;

-- T3: exception type precision/recall per planted type
with exp as (select claim_id, expected_exception_type et from OPS.GROUND_TRUTH where expected_exception_type is not null),
act as (select distinct claim_id, exception_type et from CORE.EXCEPTIONS),
types as (select et from exp union select et from act)
select 'T3 exception detection' test, ty.et exception_type,
  (select count(*) from exp where exp.et = ty.et) planted,
  (select count(*) from act where act.et = ty.et) raised,
  (select count(*) from exp join act on act.claim_id = exp.claim_id and act.et = exp.et where exp.et = ty.et) true_pos,
  iff(planted = raised and raised = true_pos, 'PASS', 'REVIEW') result
from types ty order by 2;

-- T4: document intake — classification accuracy and money-field gate
select 'T4 doc classification' test, a.true_doc_type, count(*) n,
  count_if(d.doc_type = a.true_doc_type) correct, count_if(a.scanned) scanned,
  count_if(d.status = 'OK') ok, count_if(d.status = 'LOW_CONFIDENCE') low_conf,
  count_if(d.status not in ('OK', 'LOW_CONFIDENCE')) failed,
  iff(count_if(d.doc_type = a.true_doc_type) = count(*), 'PASS', 'REVIEW') result
from RAW.ATTACHMENTS_SOURCE a left join AI.DOC_EXTRACTS d on d.attachment_id = a.attachment_id
group by 2 order by 2;

-- T5 intentionally omitted: allowed reimbursement cannot be inverted to obtain an invoice total
-- because contract caps and lesser-of-billed can bind. T4 measures classification/gating,
-- not extraction correctness. Compare extracted fields to independently labeled source values
-- before claiming monetary extraction accuracy.
