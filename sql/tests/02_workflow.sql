-- tests/02_workflow.sql — state machine, personas, idempotency, approvals, release. Run after a full simulated run
-- and after agent proposals exist for CLM2610000058 (duplicate) and CLM2610000108 (bank change).
use role ZELIS_C2C_ROLE;
use warehouse ZELIS_C2C_WH;
use database ZELIS_C2C;

-- W1: wrong persona is refused (Pricing Analyst cannot resolve an integrity exception)
call CORE.RESOLVE_EXCEPTION('EXC-CLM2610000058-PI_DUPLICATE', 1, 'DENY_DUPLICATE', null, null,
  'Priya Shah', 'PRICING_ANALYST', 'test-w1', 'should be refused');

-- W2: stale version is refused
call CORE.RESOLVE_EXCEPTION('EXC-CLM2610000058-PI_DUPLICATE', 1, 'DENY_DUPLICATE', null, null,
  'Marcus Lee', 'INTEGRITY_REVIEWER', 'test-w2', 'stale version');

-- W3: correct persona + current version resolves and re-prices the claim to 0 (denied)
set (v_ver, v_prop) = (select version, latest_proposal_id from CORE.EXCEPTIONS where exception_id = 'EXC-CLM2610000058-PI_DUPLICATE');
call CORE.RESOLVE_EXCEPTION('EXC-CLM2610000058-PI_DUPLICATE', $v_ver, 'DENY_DUPLICATE', null, $v_prop,
  'Marcus Lee', 'INTEGRITY_REVIEWER', 'test-w3', 'agree with agent');

-- W4: replaying the same idempotency key returns the stored result, no second action
call CORE.RESOLVE_EXCEPTION('EXC-CLM2610000058-PI_DUPLICATE', 99, 'DENY_DUPLICATE', null, null,
  'Marcus Lee', 'INTEGRITY_REVIEWER', 'test-w3', 'replay');

-- W5: bank hold — only the Ops Lead may resolve; fraud review escalates and keeps the payment held
set (v_ver, v_prop) = (select version, latest_proposal_id from CORE.EXCEPTIONS where exception_id = 'EXC-CLM2610000108-PY_BANK_CHANGE_HOLD');
call CORE.RESOLVE_EXCEPTION('EXC-CLM2610000108-PY_BANK_CHANGE_HOLD', $v_ver, 'HOLD_FRAUD_REVIEW', null, $v_prop,
  'Sam Rivera', 'OPS_LEAD', 'test-w5', 'TIN mismatch confirmed');

select claim_id, status, allowed_amt, payable_amt, open_exceptions, version from CORE.CLAIM_STATE
where claim_id in ('CLM2610000057', 'CLM2610000058', 'CLM2610000108') order by 1;

-- W6: batches — Pricing Analyst cannot create; Payment Approver can
call CORE.CREATE_BATCHES('Priya Shah', 'PRICING_ANALYST', 'test-w6a');
call CORE.CREATE_BATCHES('Dana Ortiz', 'PAYMENT_APPROVER', 'test-w6b');
select batch_id, payer_id, pay_method, status, claim_count, total_amt, max_claim_amt, version
from CORE.PAYMENT_BATCHES order by total_amt desc;
