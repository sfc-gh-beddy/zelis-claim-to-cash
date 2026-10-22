-- 06_agents.sql — saved Cortex Agents. Tools are read-only or propose-only; none can resolve, approve or release.
use role ZELIS_C2C_ROLE;
use warehouse ZELIS_C2C_WH;
use database ZELIS_C2C;

create or replace agent AI.PRICING_EXCEPTION_AGENT
  comment = 'Works pricing exceptions: modifier review, contract conflicts, stop-loss, out-of-network, document review'
  profile = '{"display_name": "Pricing Exception Agent", "color": "blue"}'
  from specification
$$
models:
  orchestration: claude-sonnet-5
orchestration:
  budget:
    seconds: 240
    tokens: 60000
instructions:
  orchestration: |
    You resolve one claim-pricing exception per request by PROPOSING a decision for a human Pricing Analyst.
    Follow these steps in order:
    1. Call get_exception_context with the exception_id. It returns the claim, current deterministic pricing, the
       contract terms on file, the allowed decisions, and any extracted attachments (with OCR text and extraction scores).
    2. Find the governing language. For contract questions call contract_search filtered to the claim's contract_id
       (for example ordering, carve-outs, stop-loss). For payment rules (modifiers, out-of-network) call policy_search.
    3. Call reprice_decision for each allowed decision you are seriously considering, to see the exact dollar outcome.
    4. Call submit_proposal exactly once with:
       - decision: one value from allowed_decisions
       - rationale: 2-5 sentences tying the evidence to the decision
       - citations_json: a JSON array of objects {"source": "contract"|"policy"|"document"|"claim_data",
         "ref": the chunk_id, attachment_id or field name, "quote": a short verbatim quote}
       - confidence: 0 to 1
       - risk_flags_json: a JSON array of short strings (empty array if none)
       - agent_name: "PRICING_EXCEPTION_AGENT"
    Rules: never calculate or estimate dollar amounts yourself; only repeat amounts returned by reprice_decision or
    get_exception_context. You cannot resolve exceptions, approve or release payments. If the evidence is missing or
    contradictory, still submit the best-supported decision with low confidence and a risk flag explaining what a
    human must check.
  response: |
    Reply in under 120 words: the decision you proposed, the dollar impact from reprice_decision, the key evidence,
    and anything the reviewer should double-check.
tools:
  - tool_spec:
      type: generic
      name: get_exception_context
      description: Returns everything about one exception - claim, lines, current pricing trace, contract terms, allowed decisions, extracted documents.
      input_schema:
        type: object
        properties:
          exception_id: {type: string, description: "Exception identifier, e.g. EXC-CLM2610000123-PR_BILATERAL_UNITS-L1"}
        required: [exception_id]
  - tool_spec:
      type: generic
      name: reprice_decision
      description: Dry-runs the deterministic pricing engine for a candidate decision and returns current vs proposed allowed amount. Nothing is saved.
      input_schema:
        type: object
        properties:
          exception_id: {type: string, description: "Exception identifier"}
          decision: {type: string, description: "One of the allowed decisions for this exception"}
        required: [exception_id, decision]
  - tool_spec:
      type: cortex_search
      name: contract_search
      description: Searches provider contract text by section (compensation, carve-outs, stop-loss, order of precedence, Exhibit A).
  - tool_spec:
      type: cortex_search
      name: policy_search
      description: Searches payer payment policies (modifiers, out-of-network, edits, approvals).
  - tool_spec:
      type: generic
      name: submit_proposal
      description: Records a proposed resolution for human review. Call exactly once. Does not change the claim.
      input_schema:
        type: object
        properties:
          exception_id: {type: string, description: "Exception identifier"}
          decision: {type: string, description: "One of allowed_decisions"}
          rationale: {type: string, description: "2-5 sentences"}
          citations_json: {type: string, description: "JSON array of {source, ref, quote}"}
          confidence: {type: number, description: "0 to 1"}
          risk_flags_json: {type: string, description: "JSON array of strings"}
          agent_name: {type: string, description: "Always PRICING_EXCEPTION_AGENT"}
          correlation_id: {type: string, description: "Pass the correlation_id given in the request, if any"}
        required: [exception_id, decision, rationale, citations_json, confidence, risk_flags_json, agent_name]
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: claims_analyst
      description: Answers aggregate questions about claims, exceptions and payment batches (counts, totals, rates).
tool_resources:
  get_exception_context:
    type: procedure
    identifier: ZELIS_C2C.AI.TOOL_GET_EXCEPTION_CONTEXT
    execution_environment: {type: warehouse, warehouse: ZELIS_C2C_WH, query_timeout: 60}
  reprice_decision:
    type: procedure
    identifier: ZELIS_C2C.AI.TOOL_REPRICE_DECISION
    execution_environment: {type: warehouse, warehouse: ZELIS_C2C_WH, query_timeout: 120}
  submit_proposal:
    type: procedure
    identifier: ZELIS_C2C.AI.TOOL_SUBMIT_PROPOSAL
    execution_environment: {type: warehouse, warehouse: ZELIS_C2C_WH, query_timeout: 120}
  contract_search:
    search_service: ZELIS_C2C.AI.CONTRACT_SEARCH
    max_results: 6
    id_column: CHUNK_ID
    title_column: TITLE
    columns_and_descriptions:
      CHUNK: {description: "Contract section text", type: string, searchable: false, filterable: false}
      CONTRACT_ID: {description: "Contract identifier such as CTR-01-006; filter on this to stay within the claim's contract", type: string, searchable: false, filterable: true}
      SECTION: {description: "Section heading, e.g. '6. Order of Precedence', '4. Compensation', 'Exhibit A - Code-Specific Rates'", type: string, searchable: false, filterable: true}
  policy_search:
    search_service: ZELIS_C2C.AI.POLICY_SEARCH
    max_results: 5
    id_column: CHUNK_ID
    title_column: TITLE
  claims_analyst:
    semantic_view: ZELIS_C2C.APP.C2C_SV
    execution_environment: {type: warehouse, warehouse: ZELIS_C2C_WH, query_timeout: 60}
$$;

create or replace agent AI.INTEGRITY_AGENT
  comment = 'Works payment-integrity exceptions: duplicates and corrected claims, unbundling, E/M level review'
  profile = '{"display_name": "Payment Integrity Agent", "color": "orange"}'
  from specification
$$
models:
  orchestration: claude-sonnet-5
orchestration:
  budget:
    seconds: 240
    tokens: 60000
instructions:
  orchestration: |
    You review one payment-integrity exception per request and PROPOSE a decision for a human Integrity Reviewer.
    1. Call get_exception_context with the exception_id. Check duplicate_of (frequency code 7 means a corrected
       claim that replaces the original; frequency code 1 means a true duplicate), edit_pair (component vs
       comprehensive code and whether a distinct-procedure modifier is present), the provider profile and the
       attached visit note text for E/M level reviews.
    2. Call policy_search for the governing policy (duplicate and corrected claims, code pair edits, E/M documentation).
    3. Call reprice_decision for the decision you intend to propose to get the exact dollar effect.
    4. Call submit_proposal exactly once (agent_name "INTEGRITY_AGENT") with decision, rationale, citations_json
       (JSON array of {"source","ref","quote"}), confidence 0-1 and risk_flags_json (JSON array).
    Never compute dollar amounts yourself. Do not deny on suspicion alone: base the decision on documented evidence
    and say what is missing when evidence is thin. You cannot resolve exceptions or release payments.
  response: |
    Reply in under 120 words: proposed decision, dollar effect, the evidence, and what the reviewer should verify.
tools:
  - tool_spec:
      type: generic
      name: get_exception_context
      description: Returns everything about one exception - claim, lines, duplicate candidate, edit pair, provider profile, documents.
      input_schema:
        type: object
        properties:
          exception_id: {type: string, description: "Exception identifier"}
        required: [exception_id]
  - tool_spec:
      type: generic
      name: reprice_decision
      description: Dry-runs the pricing engine for a candidate decision and returns current vs proposed allowed amount.
      input_schema:
        type: object
        properties:
          exception_id: {type: string, description: "Exception identifier"}
          decision: {type: string, description: "One of the allowed decisions"}
        required: [exception_id, decision]
  - tool_spec:
      type: cortex_search
      name: policy_search
      description: Searches payer integrity and coding policies (duplicates, corrected claims, code pair edits, E/M levels).
  - tool_spec:
      type: generic
      name: submit_proposal
      description: Records a proposed resolution for human review. Call exactly once. Does not change the claim.
      input_schema:
        type: object
        properties:
          exception_id: {type: string, description: "Exception identifier"}
          decision: {type: string, description: "One of allowed_decisions"}
          rationale: {type: string, description: "2-5 sentences"}
          citations_json: {type: string, description: "JSON array of {source, ref, quote}"}
          confidence: {type: number, description: "0 to 1"}
          risk_flags_json: {type: string, description: "JSON array of strings"}
          agent_name: {type: string, description: "Always INTEGRITY_AGENT"}
          correlation_id: {type: string, description: "Pass the correlation_id given in the request, if any"}
        required: [exception_id, decision, rationale, citations_json, confidence, risk_flags_json, agent_name]
tool_resources:
  get_exception_context:
    type: procedure
    identifier: ZELIS_C2C.AI.TOOL_GET_EXCEPTION_CONTEXT
    execution_environment: {type: warehouse, warehouse: ZELIS_C2C_WH, query_timeout: 60}
  reprice_decision:
    type: procedure
    identifier: ZELIS_C2C.AI.TOOL_REPRICE_DECISION
    execution_environment: {type: warehouse, warehouse: ZELIS_C2C_WH, query_timeout: 120}
  submit_proposal:
    type: procedure
    identifier: ZELIS_C2C.AI.TOOL_SUBMIT_PROPOSAL
    execution_environment: {type: warehouse, warehouse: ZELIS_C2C_WH, query_timeout: 120}
  policy_search:
    search_service: ZELIS_C2C.AI.POLICY_SEARCH
    max_results: 5
    id_column: CHUNK_ID
    title_column: TITLE
$$;

create or replace agent AI.PAYMENT_OPS_AGENT
  comment = 'Works payment holds (bank-account changes) and answers payment-operations questions'
  profile = '{"display_name": "Payment Operations Agent", "color": "green"}'
  from specification
$$
models:
  orchestration: claude-sonnet-5
orchestration:
  budget:
    seconds: 240
    tokens: 60000
instructions:
  orchestration: |
    Two kinds of requests:
    A) An exception_id for a payment hold. Call get_exception_context, compare the bank-change letter fields
       (payee name, TIN, bank state, contact email, verification wording, urgency language) against the provider
       record and bank history, call policy_search for the bank-change policy, then call submit_proposal exactly once
       (agent_name "PAYMENT_OPS_AGENT") with decision, rationale, citations_json (JSON array of
       {"source","ref","quote"}), confidence and risk_flags_json. List every red flag you find in risk_flags_json.
       Propose RELEASE_AFTER_VERIFICATION only when the letter is consistent with the provider record and states that
       a call-back to the number on file confirmed it; otherwise propose HOLD_FRAUD_REVIEW.
    B) A question about payment operations (readiness, batches, same-day rate, held dollars). Use claims_analyst.
    You cannot release payments or verify bank accounts yourself. Never compute dollar amounts yourself.
  response: |
    Be brief and specific. For holds: decision, red flags, what the Ops Lead must do before release.
tools:
  - tool_spec:
      type: generic
      name: get_exception_context
      description: Returns the exception, claim, provider record, bank account history and extracted bank-change letter.
      input_schema:
        type: object
        properties:
          exception_id: {type: string, description: "Exception identifier"}
        required: [exception_id]
  - tool_spec:
      type: cortex_search
      name: policy_search
      description: Searches payment-operations policies (bank-account changes, approval matrix, rails and cut-offs).
  - tool_spec:
      type: generic
      name: submit_proposal
      description: Records a proposed resolution for human review. Call exactly once per exception. Does not change anything.
      input_schema:
        type: object
        properties:
          exception_id: {type: string, description: "Exception identifier"}
          decision: {type: string, description: "RELEASE_AFTER_VERIFICATION or HOLD_FRAUD_REVIEW"}
          rationale: {type: string, description: "2-5 sentences"}
          citations_json: {type: string, description: "JSON array of {source, ref, quote}"}
          confidence: {type: number, description: "0 to 1"}
          risk_flags_json: {type: string, description: "JSON array of strings"}
          agent_name: {type: string, description: "Always PAYMENT_OPS_AGENT"}
          correlation_id: {type: string, description: "Pass the correlation_id given in the request, if any"}
        required: [exception_id, decision, rationale, citations_json, confidence, risk_flags_json, agent_name]
  - tool_spec:
      type: cortex_analyst_text_to_sql
      name: claims_analyst
      description: Answers questions about claims, exceptions, payment readiness and batches.
tool_resources:
  get_exception_context:
    type: procedure
    identifier: ZELIS_C2C.AI.TOOL_GET_EXCEPTION_CONTEXT
    execution_environment: {type: warehouse, warehouse: ZELIS_C2C_WH, query_timeout: 60}
  submit_proposal:
    type: procedure
    identifier: ZELIS_C2C.AI.TOOL_SUBMIT_PROPOSAL
    execution_environment: {type: warehouse, warehouse: ZELIS_C2C_WH, query_timeout: 120}
  policy_search:
    search_service: ZELIS_C2C.AI.POLICY_SEARCH
    max_results: 5
    id_column: CHUNK_ID
    title_column: TITLE
  claims_analyst:
    semantic_view: ZELIS_C2C.APP.C2C_SV
    execution_environment: {type: warehouse, warehouse: ZELIS_C2C_WH, query_timeout: 60}
$$;
