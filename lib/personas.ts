/**
 * Personas are an app-level simulation of roles (see README "Limitations"). The persona travels in the
 * `c2c_persona` cookie and is re-checked on the server for every mutating call; the stored procedures enforce the
 * same rules again, so a crafted request cannot bypass them.
 */
export type PersonaId = "PRICING_ANALYST" | "INTEGRITY_REVIEWER" | "PAYMENT_APPROVER" | "OPS_LEAD"

export interface Persona {
  id: PersonaId
  label: string
  person: string
  stages: Array<"PRICING" | "INTEGRITY" | "PAYMENT">
  batchLimit: number
  claimLimit: number
  canCreateBatches: boolean
  canRelease: boolean
  canControlSimulation: boolean
}

export const PERSONAS: Record<PersonaId, Persona> = {
  PRICING_ANALYST: {
    id: "PRICING_ANALYST", label: "Pricing Analyst", person: "Priya Shah", stages: ["PRICING"],
    batchLimit: 0, claimLimit: 0, canCreateBatches: false, canRelease: false, canControlSimulation: false,
  },
  INTEGRITY_REVIEWER: {
    id: "INTEGRITY_REVIEWER", label: "Integrity Reviewer", person: "Marcus Lee", stages: ["INTEGRITY"],
    batchLimit: 0, claimLimit: 0, canCreateBatches: false, canRelease: false, canControlSimulation: false,
  },
  PAYMENT_APPROVER: {
    id: "PAYMENT_APPROVER", label: "Payment Approver", person: "Dana Ortiz", stages: [],
    batchLimit: 250_000, claimLimit: 50_000, canCreateBatches: true, canRelease: true, canControlSimulation: false,
  },
  OPS_LEAD: {
    id: "OPS_LEAD", label: "Payments Ops Lead", person: "Sam Rivera", stages: ["PRICING", "INTEGRITY", "PAYMENT"],
    batchLimit: Number.MAX_SAFE_INTEGER, claimLimit: Number.MAX_SAFE_INTEGER, canCreateBatches: true, canRelease: true,
    canControlSimulation: true,
  },
}

export const DEFAULT_PERSONA: PersonaId = "OPS_LEAD"
export const PERSONA_COOKIE = "c2c_persona"

export function parsePersona(value: string | undefined | null): Persona {
  if (value && value in PERSONAS) return PERSONAS[value as PersonaId]
  return PERSONAS[DEFAULT_PERSONA]
}

/** Exception types each stage owns; bank-change holds additionally require the Ops Lead. */
export function canResolve(persona: Persona, stage: string, exceptionType: string): boolean {
  if (exceptionType === "BANK_CHANGE_HOLD") return persona.id === "OPS_LEAD"
  return persona.stages.includes(stage as Persona["stages"][number])
}

export function canApproveBatch(persona: Persona, totalAmt: number, maxClaimAmt: number):
  { ok: true } | { ok: false; reason: string } {
  if (persona.batchLimit === 0) return { ok: false, reason: `${persona.label} cannot approve payments` }
  if (totalAmt > persona.batchLimit) return { ok: false, reason: `Batch total exceeds ${persona.label} limit` }
  if (maxClaimAmt > persona.claimLimit) return { ok: false, reason: `A claim exceeds ${persona.label} per-claim limit` }
  return { ok: true }
}
