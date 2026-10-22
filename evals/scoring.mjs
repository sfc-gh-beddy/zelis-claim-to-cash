import { z } from 'zod';
export const ProposalContract = z.object({
  decision: z.string().min(1), rationale: z.string().min(20),
  citations: z.array(z.object({ source: z.string().min(1), ref: z.string().min(1), quote: z.string().min(1) })).min(1),
  confidence: z.number().min(0).max(1), risk_flags: z.array(z.string()),
});
export const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
export function sameAmount(left, right) {
  if (left == null || right == null) return false;
  return Math.round(Number(left) * 100) === Math.round(Number(right) * 100);
}
// Checks source identity + verbatim quotation, NOT whether evidence entails the decision.
export function checkCitations(citations, sources) {
  return (Array.isArray(citations) ? citations : []).map(citation => {
    const ref = String(citation.ref ?? '').trim();
    const matches = sources.filter(source => source.ids.includes(ref));
    const quote = normalize(citation.quote);
    return { ref, source_found: matches.length > 0,
      quote_matched: quote.length >= 12 && matches.some(source => normalize(source.text).includes(quote)),
      semantic_support: 'NOT_REVIEWED' };
  });
}
export function scoreProposal(proposal, expected, sources) {
  const parsed = ProposalContract.safeParse(proposal?.RAW);
  const checks = checkCitations(proposal?.CITATIONS, sources);
  const schemaValid = !!proposal && proposal.SCHEMA_VALID === true && parsed.success;
  const decisionCorrect = schemaValid && proposal.DECISION === expected.EXPECTED_DECISION;
  const amountCorrect = schemaValid && sameAmount(proposal.PROPOSED_ALLOWED_AMT, expected.EXPECTED_ALLOWED_AMT);
  const quotesMatched = checks.length > 0 && checks.every(check => check.source_found && check.quote_matched);
  return { schemaValid, decisionCorrect, amountCorrect, quotesMatched, checks,
    failureKind: !proposal ? 'no_proposal' : !schemaValid ? 'schema_violation' : !decisionCorrect ? 'wrong_decision'
      : !amountCorrect ? 'wrong_amount' : !quotesMatched ? 'citation_unverified' : null };
}
