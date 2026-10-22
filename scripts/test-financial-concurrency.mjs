// Disposable synthetic batch: concurrent release/replay checks never touch existing payments.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const tag = randomUUID().replaceAll('-', '').toUpperCase();
const batch = `BAT-TEST-${tag}`;
const claim = `CLMTEST${tag}`;
const key = randomUUID();
async function sql(statement) {
  const { stdout } = await exec('snow', ['sql', '-c', 'zelis_c2c', '-q', statement, '--format', 'JSON'], { maxBuffer: 4000000 });
  return JSON.parse(stdout);
}
const value = rows => JSON.parse(Object.values(rows[0])[0]);
try {
  await sql(`insert into ZELIS_C2C.RAW.CLAIMS select '${claim}',payer_id,provider_id,org_id,member_id,claim_type,
    frequency_code,service_from,service_to,100,sim_day,received_at,current_timestamp()
    from ZELIS_C2C.RAW.CLAIMS where claim_id='CLM2610000097';
    insert into ZELIS_C2C.CORE.CLAIM_STATE(claim_id,status,payable_amt,batch_id,version) values('${claim}','BATCHED',10,'${batch}',1);
    insert into ZELIS_C2C.CORE.PAYMENT_BATCHES(batch_id,payer_id,pay_method,status,claim_count,total_amt,max_claim_amt,created_by,created_sim_ts)
    select '${batch}',payer_id,'VCARD','DRAFT',1,10,10,'QA',ZELIS_C2C.OPS.SIM_NOW() from ZELIS_C2C.RAW.CLAIMS where claim_id='${claim}';
    insert into ZELIS_C2C.CORE.BATCH_ITEMS values('${batch}','${claim}',10,'PAID');`);
  const approved = value(await sql(`call ZELIS_C2C.CORE.APPROVE_BATCH('${batch}',1,'Dana Ortiz','PAYMENT_APPROVER','${randomUUID()}')`));
  if (!approved.ok) throw new Error(JSON.stringify(approved));
  const release = `call ZELIS_C2C.CORE.RELEASE_BATCH('${batch}',2,'Dana Ortiz','PAYMENT_APPROVER','${key}')`;
  const results = await Promise.all([sql(release), sql(release)]);
  const values = results.map(value);
  if (!values.every(result => result.ok) || values.filter(result => result.idempotent_replay).length !== 1)
    throw new Error(`Concurrency replay failed: ${JSON.stringify(values)}`);
  const ledger = await sql(`select rail_txn_id,amount from ZELIS_C2C.OPS.RAIL_LEDGER where batch_id='${batch}'`);
  if (ledger.length !== 1 || Number(ledger[0].AMOUNT) !== 10) throw new Error('Duplicate or wrong ledger amount');
  const conflict = value(await sql(`call ZELIS_C2C.CORE.RELEASE_BATCH('${batch}',3,'Dana Ortiz','PAYMENT_APPROVER','${key}')`));
  if (conflict.code !== 'IDEMPOTENCY_CONFLICT') throw new Error('Changed request reused key');
  console.log(JSON.stringify({ result: 'PASS', concurrent_release: values, ledger_transactions: ledger.length, request_conflict: conflict.code }));
} finally {
  await sql(`delete from ZELIS_C2C.OPS.WORKFLOW_REQUESTS where request:id::string='${batch}';
    delete from ZELIS_C2C.OPS.IDEMPOTENCY where result:batch_id::string='${batch}';
    delete from ZELIS_C2C.OPS.RAIL_LEDGER where batch_id='${batch}';
    delete from ZELIS_C2C.OPS.REMITTANCE_FILES where batch_id='${batch}';
    delete from ZELIS_C2C.CORE.BATCH_ITEMS where batch_id='${batch}';
    delete from ZELIS_C2C.CORE.PAYMENT_BATCHES where batch_id='${batch}';
    delete from ZELIS_C2C.CORE.CLAIM_STATE where claim_id='${claim}';
    delete from ZELIS_C2C.RAW.CLAIMS where claim_id='${claim}';
    remove @ZELIS_C2C.OPS.REMITTANCE/835/${batch}.835;`);
}
