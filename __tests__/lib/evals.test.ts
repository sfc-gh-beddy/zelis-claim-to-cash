import { describe, expect, it } from 'vitest'
import { checkCitations, sameAmount, scoreProposal } from '../../evals/scoring.mjs'

describe('evaluation scoring', () => {
  it('counts missing proposals as failures', () => {
    const result = scoreProposal(null, { EXPECTED_DECISION: 'DENY_DUPLICATE', EXPECTED_ALLOWED_AMT: 0 }, [])
    expect(result.decisionCorrect).toBe(false)
    expect(result.amountCorrect).toBe(false)
    expect(result.failureKind).toBe('no_proposal')
  })
  it('does not equate missing amounts with zero', () => {
    expect(sameAmount(null, 0)).toBe(false)
    expect(sameAmount('109.03', 109.03)).toBe(true)
    expect(sameAmount(109.02, 109.03)).toBe(false)
  })
  it('requires a matching source ID and a meaningful quote', () => {
    const sources = [{ ids: ['POL.pdf#01'], text: 'The component procedure is included.' }]
    expect(checkCitations([{ ref: 'POL.pdf#01', quote: 'component procedure is included' }], sources)[0].quote_matched).toBe(true)
    expect(checkCitations([{ ref: 'invented', quote: 'component procedure is included' }], sources)[0].source_found).toBe(false)
    expect(checkCitations([{ ref: 'POL.pdf#01', quote: 'is' }], sources)[0].quote_matched).toBe(false)
    expect(checkCitations([{ ref: 'POL.pdf#01', quote: 'The separate procedure is payable' }], sources)[0].quote_matched).toBe(false)
  })
  it('does not represent quotation matching as semantic support', () => {
    const result = checkCitations([{ ref: 'doc', quote: 'A sufficiently long quote' }], [{ ids: ['doc'], text: 'A sufficiently long quote' }])
    expect(result[0].semantic_support).toBe('NOT_REVIEWED')
  })
})
