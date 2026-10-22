"""Pricing specification shared by the data generator (ground truth) and mirrored in SQL.

Every number the pipeline produces must be reproducible from this file. The SQL engine
(sql/02_pipeline.sql: CORE.PRICE_CLAIM) implements the same rules; sql/tests asserts they
agree to the cent on every straight-through claim.

Rules (all money NUMBER(18,2), rounding ROUND_HALF_UP per line):
  standard line  = base_rate * units_eff * modifier_factor * pct / 100
      pct          = contract pct_of_base (in-network) or payer oon_pct (no contract)
      units_eff    = 1 when modifier 50 present, else units
      modifier_fac = product of MODIFIER_FACTORS for the line's modifiers (unknown -> 1.0)
  carve-out FLAT          = rate * units
  carve-out INVOICE_PLUS  = min(invoice_cost * (1 + markup_pct/100), base_rate * cap_mult * units)
  carve-out PCT_OVERRIDE  = standard line with pct replaced
  denied line             = 0
  stop-loss (claim level) = eligible_charges * stop_loss_pct / 100   when billed > threshold
  claim cap               = allowed never exceeds billed charges on a claim basis (lesser-of)
"""
from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")

MODIFIER_FACTORS = {
    "50": Decimal("1.50"),  # bilateral, priced on a single unit
    "51": Decimal("0.50"),  # multiple procedure
    "26": Decimal("0.40"),  # professional component
    "TC": Decimal("0.60"),  # technical component
    "59": Decimal("1.00"),
    "XS": Decimal("1.00"),
    "XU": Decimal("1.00"),
    "LT": Decimal("1.00"),
    "RT": Decimal("1.00"),
    "25": Decimal("1.00"),
}


def money(x) -> Decimal:
    return Decimal(str(x)).quantize(CENT, rounding=ROUND_HALF_UP)


def modifier_factor(modifiers: list[str]) -> Decimal:
    f = Decimal("1")
    for m in modifiers:
        f *= MODIFIER_FACTORS.get(m, Decimal("1"))
    return f


def standard_line(base_rate, units, modifiers, pct) -> Decimal:
    units_eff = 1 if "50" in modifiers else units
    raw = Decimal(str(base_rate)) * Decimal(units_eff) * modifier_factor(modifiers) * Decimal(str(pct)) / Decimal(100)
    return money(raw)


def flat_line(rate, units) -> Decimal:
    return money(Decimal(str(rate)) * Decimal(units))


def invoice_plus_line(invoice_cost, markup_pct, base_rate, cap_mult, units) -> Decimal:
    a = Decimal(str(invoice_cost)) * (Decimal(1) + Decimal(str(markup_pct)) / Decimal(100))
    b = Decimal(str(base_rate)) * Decimal(str(cap_mult)) * Decimal(units)
    return money(min(a, b))


def stop_loss(eligible_charges, stop_loss_pct) -> Decimal:
    return money(Decimal(str(eligible_charges)) * Decimal(str(stop_loss_pct)) / Decimal(100))


def lesser_of_billed(allowed, billed) -> Decimal:
    return money(min(Decimal(str(allowed)), Decimal(str(billed))))
