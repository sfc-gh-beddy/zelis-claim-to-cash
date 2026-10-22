import { DB, errorResponse, num, q } from "@/lib/db"
import { draftEopLetter } from "@/lib/gateway"

export const dynamic = "force-dynamic"
export const maxDuration = 120

/** GET: the 835 file + any generated EOP letters. POST: draft EOP letters (gateway) for the batch's top providers. */
export async function GET(_req: Request, ctx: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await ctx.params
  if (!/^BAT-[A-Z0-9-]+$/.test(batchId)) return Response.json({ error: "bad id" }, { status: 400 })
  try {
    const [file] = await q(`select format, file_path, content, created_at from ${DB}.OPS.REMITTANCE_FILES where batch_id = ?`, [batchId])
    const letters = await q(`select l.org_id, o.org_name, l.claim_count, l.amount, l.letter, l.validated, l.validation, l.created_at
      from ${DB}.OPS.EOP_LETTERS l join ${DB}.CORE.PROVIDER_ORGS o on o.org_id = l.org_id
      where l.batch_id = ? order by l.amount desc`, [batchId])
    const ledger = await q(`select r.org_id, o.org_name, r.rail, r.amount, r.trace_number, r.status, r.expected_settlement_date, r.adapter
      from ${DB}.OPS.RAIL_LEDGER r join ${DB}.CORE.PROVIDER_ORGS o on o.org_id = r.org_id where r.batch_id = ? order by r.amount desc`,
      [batchId])
    return Response.json({ file: file ?? null, letters: letters.map((l) => ({ ...l, amount: num(l.amount) })),
      ledger: ledger.map((l) => ({ ...l, amount: num(l.amount) })) })
  } catch (e) {
    return errorResponse(e, "remittance failed")
  }
}

export async function POST(_req: Request, ctx: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await ctx.params
  if (!/^BAT-[A-Z0-9-]+$/.test(batchId)) return Response.json({ error: "bad id" }, { status: 400 })
  try {
    const [b] = await q(`select b.status, b.pay_method, b.expected_settlement_date, p.payer_name
      from ${DB}.CORE.PAYMENT_BATCHES b join ${DB}.CORE.PAYERS p on p.payer_id = b.payer_id where b.batch_id = ?`, [batchId])
    if (!b) return Response.json({ error: "not found" }, { status: 404 })
    if (b.status !== "RELEASED") return Response.json({ error: "batch not released" }, { status: 409 })
    const providers = await q(`select c.org_id, o.org_name, count(*) n, sum(i.payable_amt) amt,
        array_agg(object_construct('claim_id', i.claim_id, 'billed', c.billed_amt, 'paid', i.payable_amt,
          'disposition', i.disposition)) within group (order by i.claim_id) claims
      from ${DB}.CORE.BATCH_ITEMS i join ${DB}.RAW.CLAIMS c on c.claim_id = i.claim_id
      join ${DB}.CORE.PROVIDER_ORGS o on o.org_id = c.org_id
      where i.batch_id = ? and c.org_id not in (select org_id from ${DB}.OPS.EOP_LETTERS where batch_id = ?)
      group by 1, 2 order by amt desc limit 3`, [batchId, batchId])
    const out = []
    for (const p of providers) {
      const all = (typeof p.claims === "string" ? JSON.parse(p.claims) : p.claims)
        .map((c: any) => ({ claim_id: c.claim_id, billed: Number(c.billed), paid: Number(c.paid), disposition: c.disposition }))
      const listed = all.slice(0, 6)
      const rest = all.slice(6)
      // Facts must reconcile: listed claims + one "other claims" line sum exactly to the provider total.
      const restPaid = Math.round(rest.reduce((a: number, c: any) => a + c.paid * 100, 0)) / 100
      const r = await draftEopLetter({ batchId, orgId: String(p.org_id), orgName: String(p.org_name),
        payerName: String(b.payer_name), rail: String(b.pay_method), settlementDate: String(b.expected_settlement_date).slice(0, 10),
        total: Number(p.amt), claimCount: all.length, claims: listed,
        otherClaims: rest.length ? { count: rest.length, paid: restPaid } : null })
      await q(`insert into ${DB}.OPS.EOP_LETTERS (batch_id, org_id, claim_count, amount, letter, validated, validation, model, call_id)
               select ?, ?, ?, ?, ?, ?, parse_json(?), ?, ?`,
        [batchId, p.org_id, num(p.n), num(p.amt), r.letter, r.validated, JSON.stringify(r.validation),
         process.env.C2C_FAST_MODEL ?? "claude-haiku-5-5", r.callId])
      out.push({ org_id: p.org_id, validated: r.validated, validation: r.validation })
    }
    return Response.json({ drafted: out })
  } catch (e) {
    return errorResponse(e, "EOP drafting failed")
  }
}
