"""Deterministic synthetic data generator for Zelis Claim-to-Cash.

Writes CSVs to out/tables and documents to out/docs (contracts, policies) and
out/attachments (claim attachments, some rendered as degraded scans).

Everything is synthetic: no real members, providers, payers, rates or PHI.
Run:  .venv/bin/python generate.py [--days 3] [--claims-per-day 1200] [--seed 20261026]
"""
from __future__ import annotations

import argparse
import csv
import json
import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import docs
from pricing_spec import flat_line, invoice_plus_line, lesser_of_billed, money, standard_line, stop_loss

OUT = Path(__file__).parent / "out"
SIM_START = date(2026, 10, 26)  # Monday
BUSINESS_MINUTES = 600          # 08:00-18:00 simulated business day

# ---------------------------------------------------------------- reference data
PAYERS = [
    # payer_id, name, oon_pct, oon_review_threshold, oon_negotiate_threshold
    ("PAY01", "Meridian Health Plan", 140, 10000, 25000),
    ("PAY02", "Cascade Benefit Trust", 125, 10000, 25000),
    ("PAY03", "Lakeshore Employers TPA", 150, 10000, 25000),
    ("PAY04", "Summit Mutual Health", 130, 10000, 25000),
]
STANDARD_PCT = {"PAY01": 118, "PAY02": 112, "PAY03": 125, "PAY04": 115}

# code, description (synthetic paraphrase), base_rate, bilateral_eligible, category
FEE_SCHEDULE = [
    ("99212", "Office visit, established, straightforward", 58.10, False, "EM"),
    ("99213", "Office visit, established, low complexity", 92.40, False, "EM"),
    ("99214", "Office visit, established, moderate complexity", 131.60, False, "EM"),
    ("99215", "Office visit, established, high complexity", 184.90, False, "EM"),
    ("99283", "Emergency dept visit, moderate", 141.20, False, "ED"),
    ("99284", "Emergency dept visit, high", 238.70, False, "ED"),
    ("99285", "Emergency dept visit, high severity", 348.30, False, "ED"),
    ("70450", "CT head without contrast", 112.80, False, "IMG"),
    ("71046", "Chest x-ray, 2 views", 31.40, False, "IMG"),
    ("73721", "MRI lower extremity joint without contrast", 218.60, False, "IMG"),
    ("74177", "CT abdomen and pelvis with contrast", 312.50, False, "IMG"),
    ("76942", "Ultrasound guidance for needle placement", 58.90, False, "IMG"),
    ("77003", "Fluoroscopic guidance for spine injection", 78.20, False, "IMG"),
    ("80053", "Comprehensive metabolic panel", 10.60, False, "LAB"),
    ("82947", "Glucose, quantitative", 3.90, False, "LAB"),
    ("85025", "Complete blood count with differential", 7.80, False, "LAB"),
    ("36415", "Routine venipuncture", 3.00, False, "LAB"),
    ("97110", "Therapeutic exercise, 15 min", 29.80, False, "PT"),
    ("97140", "Manual therapy, 15 min", 27.60, False, "PT"),
    ("97530", "Therapeutic activities, 15 min", 33.10, False, "PT"),
    ("20610", "Arthrocentesis/injection, major joint", 64.20, True, "PROC"),
    ("64483", "Transforaminal epidural injection, lumbar, single level", 192.40, True, "PROC"),
    ("64493", "Facet joint injection, lumbar, single level", 168.70, True, "PROC"),
    ("69210", "Removal of impacted cerumen", 44.30, True, "PROC"),
    ("67028", "Intravitreal injection", 104.60, True, "PROC"),
    ("66984", "Cataract removal with lens insertion", 548.20, False, "SURG"),
    ("29880", "Knee arthroscopy, medial and lateral meniscectomy", 512.30, False, "SURG"),
    ("29881", "Knee arthroscopy, single-compartment meniscectomy", 471.80, False, "SURG"),
    ("27447", "Total knee arthroplasty", 1389.40, False, "SURG"),
    ("27130", "Total hip arthroplasty", 1402.70, False, "SURG"),
    ("J1100", "Dexamethasone injection, 1 mg", 0.40, False, "DRUG"),
    ("J0585", "Onabotulinumtoxin A, 1 unit", 6.70, False, "DRUG"),
    ("C1776", "Joint device, implantable", 2100.00, False, "IMPLANT"),
    ("L8699", "Prosthetic implant, not otherwise specified", 1800.00, False, "IMPLANT"),
    ("A0427", "Ambulance, ALS emergency", 487.50, False, "AMB"),
    ("E0114", "Crutches, underarm, pair", 28.40, False, "DME"),
]
FS = {c[0]: c for c in FEE_SCHEDULE}

# column1 (comprehensive) / column2 (component) pairs; modifier 59/XS/XU permits separate payment
EDIT_PAIRS = [
    ("20610", "76942"), ("64483", "77003"), ("64493", "77003"), ("29881", "29880"),
    ("97140", "97530"), ("80053", "82947"),
]
EDIT_SET = {(a, b) for a, b in EDIT_PAIRS}
BYPASS_MODS = {"59", "XS", "XU"}

SPECIALTIES = {
    # specialty: (code pool for random lines, claim_type, typical lines)
    "Family Medicine": (["99212", "99213", "99214", "80053", "85025", "36415", "71046"], "PROF", (1, 3)),
    "Internal Medicine": (["99213", "99214", "99215", "80053", "85025", "36415"], "PROF", (1, 3)),
    "Orthopedics": (["99213", "99214", "73721", "20610", "29881", "E0114", "J1100"], "PROF", (1, 3)),
    "Pain Management": (["99213", "99214", "64483", "64493", "J1100"], "PROF", (1, 2)),
    "Physical Therapy": (["97110", "97140", "97530"], "PROF", (1, 2)),
    "Ophthalmology": (["99213", "99214", "67028", "66984"], "PROF", (1, 2)),
    "Otolaryngology": (["99213", "99214", "69210"], "PROF", (1, 2)),
    "Radiology": (["70450", "71046", "73721", "74177"], "PROF", (1, 2)),
    "Emergency Medicine": (["99283", "99284", "99285", "70450", "71046", "80053", "85025"], "PROF", (1, 4)),
    "Neurology": (["99213", "99214", "99215", "J0585", "70450"], "PROF", (1, 2)),
    "Hospital": (["99284", "99285", "74177", "70450", "80053", "85025", "27447", "27130"], "INST", (2, 5)),
    "Ambulance": (["A0427"], "PROF", (1, 1)),
}

ORG_WORDS_A = ["Riverside", "Northgate", "Lakeview", "Harbor", "Summit", "Cedar", "Pinecrest", "Granite", "Bayview",
               "Meadowbrook", "Silverline", "Ironwood", "Westfield", "Brightwater", "Oak Hollow", "Redstone",
               "Clearwater", "Highland", "Maple Grove", "Stonebridge", "Willow Creek", "Eastport", "Sunridge",
               "Fairhaven", "Copper Hill", "Blue Ridge", "Kingsley", "Ashford", "Mill Valley", "Crescent"]
ORG_WORDS_B = {"Family Medicine": "Family Medicine", "Internal Medicine": "Internal Medicine Group",
               "Orthopedics": "Orthopedic Associates", "Pain Management": "Spine & Pain Center",
               "Physical Therapy": "Physical Therapy", "Ophthalmology": "Eye Institute",
               "Otolaryngology": "ENT Specialists", "Radiology": "Imaging Center",
               "Emergency Medicine": "Emergency Physicians", "Neurology": "Neurology Partners",
               "Hospital": "Regional Medical Center", "Ambulance": "EMS"}
FIRST = ["Avery", "Jordan", "Morgan", "Riley", "Casey", "Taylor", "Quinn", "Reese", "Dakota", "Skyler", "Rowan",
         "Emerson", "Hayden", "Parker", "Sawyer", "Logan", "Kendall", "Finley", "Harper", "Blake"]
LAST = ["Okafor", "Lindqvist", "Ramirez", "Chen", "Haddad", "Novak", "Patel", "Brennan", "Moreau", "Tanaka",
        "Abernathy", "Kowalski", "Delgado", "Whitfield", "Sato", "Iverson", "Mensah", "Castellano", "Holt", "Varga"]
BANKS = [("First Prairie Bank", "IA"), ("Coastal Federal Credit Union", "OR"), ("Mercantile Trust", "OH"),
         ("Lone Peak Bank", "UT"), ("Harborline National", "MD"), ("Granite State Savings", "NH"),
         ("Delta Commerce Bank", "MS"), ("Sierra Pacific Bank", "NV")]
STATES = ["TX", "FL", "GA", "OH", "PA", "AZ", "NC", "TN", "CO", "MI"]


def npi(rng: random.Random) -> str:
    """Synthetic NPI with a valid Luhn check digit (prefix 80840 per NPI standard)."""
    body = "1" + "".join(str(rng.randint(0, 9)) for _ in range(8))
    digits = [int(d) for d in "80840" + body]
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 0:
            d *= 2
            d = d - 9 if d > 9 else d
        total += d
    return body + str((10 - total % 10) % 10)


def tin(rng: random.Random) -> str:
    return f"{rng.randint(10, 98)}-{rng.randint(1000000, 9999999)}"


@dataclass
class Org:
    org_id: str
    name: str
    tin: str
    specialty: str
    state: str
    kind: str                      # CONTRACTED | SOLO_PAR | SOLO_OON
    providers: list = field(default_factory=list)
    epay_enrolled: bool = True
    pay_method: str = "ACH"
    bank: dict = field(default_factory=dict)
    flags: set = field(default_factory=set)  # EM_OUTLIER, BANK_CHANGE, AMBIGUOUS
    payer_ids: list = field(default_factory=list)


@dataclass
class Contract:
    contract_id: str
    payer_id: str
    org_id: str | None             # None => payer standard participation agreement
    pct: int
    timely_filing_days: int
    payment_days: int
    stop_loss_threshold: int | None = None
    stop_loss_pct: int | None = None
    carveouts: list = field(default_factory=list)  # dicts
    precedence: str = "BODY"       # BODY | EXHIBIT  (which controls on conflict)
    ambiguous: bool = False


def build_reference(rng: random.Random):
    orgs: list[Org] = []
    contracts: list[Contract] = []
    providers = []
    used_names = set()

    def org_name(spec):
        while True:
            n = f"{rng.choice(ORG_WORDS_A)} {ORG_WORDS_B[spec]}"
            if n not in used_names:
                used_names.add(n)
                return n

    contracted_specs = (["Orthopedics"] * 5 + ["Hospital"] * 5 + ["Pain Management"] * 3 + ["Radiology"] * 3 +
                        ["Emergency Medicine"] * 3 + ["Internal Medicine"] * 3 + ["Ophthalmology"] * 2 +
                        ["Physical Therapy"] * 2 + ["Neurology"] * 2 + ["Ambulance"] * 2)
    for i, spec in enumerate(contracted_specs):
        o = Org(f"ORG{i + 1:03d}", org_name(spec), tin(rng), spec, rng.choice(STATES), "CONTRACTED")
        o.payer_ids = rng.sample([p[0] for p in PAYERS], rng.choice([1, 2, 2]))
        orgs.append(o)
    solo_specs = list(SPECIALTIES.keys())
    solo_specs.remove("Hospital")
    for j in range(120):
        spec = rng.choice(solo_specs)
        kind = "SOLO_PAR" if j < 90 else "SOLO_OON"
        name = f"{rng.choice(FIRST)} {rng.choice(LAST)}, MD" if spec not in ("Ambulance", "Physical Therapy") else org_name(spec)
        o = Org(f"ORG{len(orgs) + 1:03d}", name, tin(rng), spec, rng.choice(STATES), kind)
        orgs.append(o)

    # NPIs
    for o in orgs:
        n = rng.randint(4, 10) if o.kind == "CONTRACTED" else 1
        for _ in range(n):
            pid = f"PRV{len(providers) + 1:04d}"
            nm = f"{rng.choice(FIRST)} {rng.choice(LAST)}" + (", MD" if o.specialty not in ("Ambulance", "Physical Therapy", "Hospital") else "")
            providers.append({"provider_id": pid, "npi": npi(rng), "provider_name": nm, "org_id": o.org_id,
                              "specialty": o.specialty})
            o.providers.append(pid)

    # payment profile + banks
    for o in orgs:
        o.epay_enrolled = rng.random() < 0.82
        o.pay_method = (rng.choice(["ACH", "ACH", "ACH", "VCARD"]) if o.epay_enrolled else "CHECK")
        bank, bstate = rng.choice(BANKS)
        o.bank = {"bank_name": bank, "routing_last4": f"{rng.randint(0, 9999):04d}",
                  "account_last4": f"{rng.randint(0, 9999):04d}", "bank_state": bstate,
                  "effective_from": "2024-01-01"}

    # special flags (scenario-only orgs are excluded from the random claim pool)
    solo_par = [o for o in orgs if o.kind == "SOLO_PAR"]
    em_capable = [o for o in solo_par if o.specialty in ("Internal Medicine", "Family Medicine", "Neurology")]
    for o in rng.sample(em_capable, 12):
        o.flags.add("EM_OUTLIER")
    bank_pool = [o for o in solo_par if not o.flags and o.epay_enrolled and o.pay_method == "ACH"]
    for o in rng.sample(bank_pool, 24):
        o.flags.add("BANK_CHANGE")

    # contracts
    for o in [x for x in orgs if x.kind == "CONTRACTED"]:
        for payer_id in o.payer_ids:
            c = Contract(f"CTR-{payer_id[-2:]}-{o.org_id[-3:]}", payer_id, o.org_id,
                         pct=rng.choice([115, 120, 125, 130, 135, 140, 145, 150, 160, 175]),
                         timely_filing_days=rng.choice([90, 120, 180]), payment_days=rng.choice([15, 21, 30]))
            if o.specialty == "Hospital":
                c.stop_loss_threshold = rng.choice([100000, 125000, 150000])
                c.stop_loss_pct = rng.choice([55, 60, 65, 70])
            if o.specialty in ("Orthopedics", "Hospital"):
                c.carveouts.append({"code": "C1776", "rate_type": "INVOICE_PLUS", "markup_pct": 10, "cap_mult": 3,
                                    "source": "BODY 4.2"})
                c.carveouts.append({"code": "L8699", "rate_type": "INVOICE_PLUS", "markup_pct": 10, "cap_mult": 3,
                                    "source": "BODY 4.2"})
            if o.specialty == "Ophthalmology":
                c.carveouts.append({"code": "66984", "rate_type": "FLAT", "rate": 1450.00, "source": "EXHIBIT A"})
            if o.specialty == "Emergency Medicine":
                c.carveouts.append({"code": "99285", "rate_type": "PCT_OVERRIDE", "pct": 185, "source": "EXHIBIT A"})
            c.precedence = rng.choice(["BODY", "EXHIBIT"])
            contracts.append(c)
    # ambiguity: some ortho/hospital contracts list L8699 again in Exhibit A with a conflicting rate
    implant_ctrs = [c for c in contracts if any(cv["code"] == "L8699" for cv in c.carveouts)]
    for c in rng.sample(implant_ctrs, min(5, len(implant_ctrs))):
        c.ambiguous = True
        c.carveouts.append({"code": "L8699", "rate_type": "PCT_OVERRIDE", "pct": 160, "source": "EXHIBIT A"})
    for payer_id, *_ in PAYERS:
        contracts.append(Contract(f"STD-{payer_id[-2:]}", payer_id, None, STANDARD_PCT[payer_id], 120, 30))
    return orgs, providers, contracts


# ------------------------------------------------------------------ claims
class ClaimFactory:
    def __init__(self, rng, orgs, providers, contracts):
        self.rng = rng
        self.orgs = {o.org_id: o for o in orgs}
        self.providers = {p["provider_id"]: p for p in providers}
        self.contracts = contracts
        self.by_payer_org = {(c.payer_id, c.org_id): c for c in contracts if c.org_id}
        self.std = {c.payer_id: c for c in contracts if c.org_id is None}
        self.payer = {p[0]: p for p in PAYERS}
        self.seq = 0
        self.claims, self.lines, self.attachments, self.truth = [], [], [], []

    # -- helpers
    def contract_for(self, payer_id, org: Org):
        if org.kind == "CONTRACTED":
            return self.by_payer_org.get((payer_id, org.org_id))
        if org.kind == "SOLO_PAR":
            return self.std[payer_id]
        return None

    def pct_for(self, payer_id, org):
        c = self.contract_for(payer_id, org)
        return c.pct if c else self.payer[payer_id][2]

    def member(self):
        return f"M{self.rng.randint(100000000, 999999999)}"

    def charge(self, code, units, mult=None):
        mult = mult or self.rng.uniform(2.0, 3.4)
        return money(Decimal(str(FS[code][2])) * Decimal(units) * Decimal(str(round(mult, 3))))

    def new_claim(self, day, org: Org, payer_id, lines, minute=None, freq="1", member=None, service_from=None,
                  provider_id=None):
        self.seq += 1
        cid = f"CLM{SIM_START.strftime('%y%m')}{self.seq:06d}"
        sim_date = SIM_START + timedelta(days=day)
        svc = service_from or (sim_date - timedelta(days=self.rng.randint(3, 28)))
        minute = self.rng.randint(0, BUSINESS_MINUTES - 30) if minute is None else minute
        pid = provider_id or self.rng.choice(org.providers)
        claim = {"claim_id": cid, "sim_day": day + 1, "release_minute": minute, "payer_id": payer_id,
                 "provider_id": pid, "org_id": org.org_id, "member_id": member or self.member(),
                 "claim_type": SPECIALTIES[org.specialty][1], "frequency_code": freq,
                 "service_from": svc.isoformat(), "service_to": svc.isoformat(),
                 "received_date": sim_date.isoformat(), "billed_amt": None}
        total = Decimal(0)
        for i, ln in enumerate(lines, 1):
            billed = ln.get("billed") or self.charge(ln["code"], ln.get("units", 1))
            total += billed
            self.lines.append({"claim_id": cid, "line_no": i, "code": ln["code"],
                               "modifiers": ",".join(ln.get("mods", [])), "units": ln.get("units", 1),
                               "billed_amt": str(billed)})
        claim["billed_amt"] = str(money(total))
        self.claims.append(claim)
        return claim

    def price_standard(self, claim, org, overrides=None):
        """Ground-truth allowed amount for lines priced by standard/flat/pct rules."""
        overrides = overrides or {}
        c = self.contract_for(claim["payer_id"], org)
        pct = c.pct if c else self.payer[claim["payer_id"]][2]
        carve = {cv["code"]: cv for cv in (c.carveouts if c else [])}
        total = Decimal(0)
        line_amts = []
        for ln in [x for x in self.lines if x["claim_id"] == claim["claim_id"]]:
            mods = [m for m in ln["modifiers"].split(",") if m]
            code, units = ln["code"], int(ln["units"])
            if ln["line_no"] in overrides:
                amt = overrides[ln["line_no"]]
            elif code in carve and carve[code]["rate_type"] == "FLAT":
                amt = flat_line(carve[code]["rate"], units)
            elif code in carve and carve[code]["rate_type"] == "PCT_OVERRIDE":
                amt = standard_line(FS[code][2], units, mods, carve[code]["pct"])
            else:
                amt = standard_line(FS[code][2], units, mods, pct)
            line_amts.append({"line_no": ln["line_no"], "allowed": str(amt)})
            total += amt
        return money(total), line_amts

    def random_lines(self, org: Org):
        pool, _, (lo, hi) = SPECIALTIES[org.specialty]
        pool = [c for c in pool if not (org.flags & {"EM_OUTLIER"} and c == "99215")]
        pool = [c for c in pool if FS[c][4] != "IMPLANT"]
        n = self.rng.randint(lo, hi)
        codes = []
        for _ in range(n * 3):
            if len(codes) == n:
                break
            c = self.rng.choice(pool)
            if c in codes:
                continue
            if any((a, c) in EDIT_SET or (c, a) in EDIT_SET for a in codes):
                continue
            codes.append(c)
        lines = []
        for c in codes:
            cat = FS[c][4]
            units = self.rng.choice([1, 2, 3, 4]) if cat in ("PT",) else (self.rng.choice([1, 4, 8]) if cat == "DRUG" else 1)
            mods = []
            if FS[c][3] and self.rng.random() < 0.3:
                mods = ["50"]
            elif cat == "IMG" and org.specialty == "Radiology" and self.rng.random() < 0.4:
                mods = ["26"]
            lines.append({"code": c, "units": units, "mods": mods})
        return lines

    def truth_row(self, claim, scenario, route, exc_type, decision, amount, line_actions=None, evidence=None,
                  notes=""):
        amount = lesser_of_billed(amount, claim["billed_amt"])
        self.truth.append({"claim_id": claim["claim_id"], "scenario": scenario, "expected_route": route,
                           "expected_exception_type": exc_type or "", "expected_decision": decision,
                           "expected_allowed_amt": str(amount),
                           "expected_line_actions": json.dumps(line_actions or []),
                           "key_evidence": json.dumps(evidence or {}), "notes": notes})

    def attach(self, claim, doc_type, payload, scanned):
        aid = f"{claim['claim_id']}_{len([a for a in self.attachments if a['claim_id'] == claim['claim_id']]) + 1}"
        self.attachments.append({"attachment_id": aid, "claim_id": claim["claim_id"], "sim_day": claim["sim_day"],
                                 "release_minute": claim["release_minute"],  # submitted with the claim (837 + PWK)
                                 "file_name": f"{aid}.pdf", "true_doc_type": doc_type, "scanned": scanned,
                                 "payload": payload})


def generate_day(f: ClaimFactory, day: int, n_claims: int, orgs: list[Org]):
    rng = f.rng
    payer_ids = [p[0] for p in PAYERS]
    random_pool = [o for o in orgs if not o.flags and o.specialty != "Hospital"]
    hospitals = [o for o in orgs if o.specialty == "Hospital"]
    weights = [6 if o.kind == "CONTRACTED" else 1 for o in random_pool]
    scen_claims = 0

    def pick_payer(o):
        return rng.choice(o.payer_ids) if o.kind == "CONTRACTED" else rng.choice(payer_ids)

    # ---- P_MISSING_MODIFIER: bilateral-eligible code billed units=2 without 50; op note decides
    bil_orgs = [o for o in random_pool if any(FS[c][3] for c in SPECIALTIES[o.specialty][0])]
    for k in range(18):
        o = rng.choice(bil_orgs)
        code = rng.choice([c for c in SPECIALTIES[o.specialty][0] if FS[c][3]])
        payer = pick_payer(o)
        cl = f.new_claim(day, o, payer, [{"code": code, "units": 2, "mods": []}])
        truly_bilateral = k % 2 == 0
        pct = f.pct_for(payer, o)
        if truly_bilateral:
            amt = standard_line(FS[code][2], 1, ["50"], pct)
            decision, actions = "APPLY_MODIFIER_50", [{"line_no": 1, "action": "ADD_MODIFIER", "modifier": "50"}]
        else:
            amt = standard_line(FS[code][2], 2, [], pct)
            decision, actions = "PRICE_AS_BILLED", [{"line_no": 1, "action": "NONE"}]
        f.truth_row(cl, "P_MISSING_MODIFIER", "PRICING", "MODIFIER_REVIEW", decision, amt, actions,
                    {"doc_type": "operative_note", "field": "laterality"})
        f.attach(cl, "operative_note", {"code": code, "desc": FS[code][1], "bilateral": truly_bilateral,
                                        "provider": f.providers[cl["provider_id"]]["provider_name"],
                                        "service_date": cl["service_from"]}, scanned=rng.random() < 0.4)
        scen_claims += 1

    # ---- P_IMPLANT_CLEAN + P_CONTRACT_AMBIGUITY: implant lines need invoice cost
    implant_ctrs = [c for c in f.contracts if c.org_id and any(cv["code"] in ("C1776", "L8699") for cv in c.carveouts)]
    clean_ctrs = [c for c in implant_ctrs if not c.ambiguous]
    amb_ctrs = [c for c in implant_ctrs if c.ambiguous]
    for k in range(18):
        ambiguous = k < 10
        c = rng.choice(amb_ctrs if ambiguous else clean_ctrs)
        o = f.orgs[c.org_id]
        code = "L8699" if ambiguous else rng.choice(["C1776", "L8699"])
        proc = "27447" if o.specialty == "Hospital" or rng.random() < 0.5 else "29881"
        invoice = money(rng.uniform(2400, 7800))
        cl = f.new_claim(day, o, c.payer_id, [{"code": proc}, {"code": code, "billed": money(invoice * Decimal("2.6"))}])
        proc_amt = standard_line(FS[proc][2], 1, [], c.pct)
        inv_amt = invoice_plus_line(invoice, 10, FS[code][2], 3, 1)
        if ambiguous:
            exh_amt = standard_line(FS[code][2], 1, [], 160)
            implant_amt = exh_amt if c.precedence == "EXHIBIT" else inv_amt
            decision = "APPLY_EXHIBIT_RATE" if c.precedence == "EXHIBIT" else "APPLY_INVOICE_PLUS"
            f.truth_row(cl, "P_CONTRACT_AMBIGUITY", "PRICING", "CONTRACT_CONFLICT", decision, proc_amt + implant_amt,
                        [{"line_no": 2, "action": decision}],
                        {"doc_type": "contract", "contract_id": c.contract_id, "section": "6. Order of Precedence"})
        else:
            f.truth_row(cl, "P_IMPLANT_CLEAN", "STP", "", "AUTO_PRICED", proc_amt + inv_amt,
                        evidence={"doc_type": "implant_invoice", "field": "invoice_total"})
        f.attach(cl, "implant_invoice", {"code": code, "invoice_total": str(invoice),
                                         "vendor": rng.choice(["Apex Orthopaedic Supply", "Meridian Implant Systems",
                                                               "TriCore Surgical", "Northline Medical Devices"]),
                                         "facility": o.name, "service_date": cl["service_from"]},
                 scanned=rng.random() < 0.35)
        scen_claims += 1

    # ---- P_STOP_LOSS: hospital claim billed above threshold; itemized bill has non-covered items
    for k in range(8):
        c = rng.choice([x for x in f.contracts if x.stop_loss_threshold])
        o = f.orgs[c.org_id]
        target = rng.uniform(c.stop_loss_threshold * 1.08, c.stop_loss_threshold * 1.6)
        room_board = money(target * 0.42)
        # line charges must total the target: facility charges (room and board, OR) roll into the procedure line
        lines = [{"code": "27447", "billed": money(target * 0.62)}, {"code": "74177", "billed": money(target * 0.12)},
                 {"code": "80053", "billed": money(target * 0.06)}, {"code": "99285", "billed": money(target * 0.20)}]
        cl = f.new_claim(day, o, c.payer_id, lines)
        billed = Decimal(cl["billed_amt"])
        noncovered = money(billed * Decimal(str(round(rng.uniform(0.04, 0.11), 3))))
        eligible = billed - noncovered
        amt = stop_loss(eligible, c.stop_loss_pct)
        f.truth_row(cl, "P_STOP_LOSS", "PRICING", "STOP_LOSS_REVIEW", "APPLY_STOP_LOSS", amt, [],
                    {"doc_type": "itemized_bill", "field": "non_covered_total", "contract_id": c.contract_id})
        f.attach(cl, "itemized_bill", {"facility": o.name, "billed_total": str(billed), "non_covered": str(noncovered),
                                       "room_board": str(room_board), "service_date": cl["service_from"]},
                 scanned=rng.random() < 0.5)
        scen_claims += 1
        _ = room_board

    # ---- P_OON_REVIEW: out-of-network billed > review threshold
    oon = [o for o in random_pool if o.kind == "SOLO_OON" and o.specialty in ("Orthopedics", "Pain Management",
                                                                               "Ophthalmology", "Emergency Medicine")]
    for k in range(10):
        o = rng.choice(oon)
        payer = rng.choice(payer_ids)
        _, _, rev_t, neg_t = f.payer[payer][1:]
        big = k % 2 == 0
        if o.specialty == "Orthopedics":
            lines = [{"code": "29881", "units": 1}, {"code": "73721"}]
        elif o.specialty == "Pain Management":
            lines = [{"code": "64483", "mods": ["50"]}, {"code": "64493", "mods": ["50"]}]
        elif o.specialty == "Ophthalmology":
            lines = [{"code": "66984"}, {"code": "67028", "mods": ["50"]}]
        else:
            lines = [{"code": "99285"}, {"code": "74177"}, {"code": "70450"}]
        target = rng.uniform(neg_t * 1.1, neg_t * 1.9) if big else rng.uniform(rev_t * 1.1, neg_t * 0.9)
        scale = Decimal(str(target)) / sum(Decimal(str(FS[l["code"]][2])) for l in lines)
        for l in lines:
            l["billed"] = money(Decimal(str(FS[l["code"]][2])) * scale)
        cl = f.new_claim(day, o, payer, lines)
        amt, _ = f.price_standard(cl, o)
        decision = "NEGOTIATE_OFFER" if big else "PRICE_AT_OON_POLICY"
        f.truth_row(cl, "P_OON_REVIEW", "PRICING", "OON_REVIEW", decision, amt, [],
                    {"doc_type": "policy", "policy": "Out-of-Network Reimbursement Policy"})
        scen_claims += 1

    # ---- I_DUPLICATE: exact repeat of an earlier claim (freq 1 = duplicate, freq 7 = corrected replacement)
    for k in range(12):
        o = rng.choice([x for x in random_pool if x.kind != "SOLO_OON"])
        payer = pick_payer(o)
        lines = f.random_lines(o)
        orig_minute = rng.randint(0, 250)
        mem = f.member()
        svc = SIM_START + timedelta(days=day) - timedelta(days=rng.randint(4, 20))
        prov = rng.choice(o.providers)
        orig = f.new_claim(day, o, payer, [dict(l) for l in lines], minute=orig_minute, member=mem, service_from=svc,
                           provider_id=prov)
        o_amt, _ = f.price_standard(orig, o)
        f.truth_row(orig, "I_DUPLICATE_ORIGINAL", "STP", "", "AUTO_PRICED", o_amt)
        corrected = k % 3 == 0
        dup_lines = [dict(l) for l in lines]
        if corrected:
            dup_lines[0]["units"] = dup_lines[0].get("units", 1)
            dup_lines[0]["billed"] = None
        dup = f.new_claim(day, o, payer, dup_lines, minute=rng.randint(orig_minute + 60, BUSINESS_MINUTES - 30),
                          freq="7" if corrected else "1", member=mem, service_from=svc, provider_id=prov)
        d_amt, _ = f.price_standard(dup, o)
        if corrected:
            f.truth_row(dup, "I_CORRECTED_CLAIM", "INTEGRITY", "DUPLICATE_SUSPECT", "REPLACE_ORIGINAL", d_amt,
                        [{"action": "VOID_ORIGINAL", "claim_id": orig["claim_id"]}],
                        {"field": "frequency_code", "value": "7"})
        else:
            f.truth_row(dup, "I_DUPLICATE", "INTEGRITY", "DUPLICATE_SUSPECT", "DENY_DUPLICATE", Decimal("0.00"),
                        [{"action": "DENY_CLAIM"}], {"field": "duplicate_of", "value": orig["claim_id"]})
        scen_claims += 2

    # ---- I_UNBUNDLING: edit pair without bypass modifier (+ controls with 59 that must clear)
    pair_orgs = {"20610": "Orthopedics", "64483": "Pain Management", "64493": "Pain Management",
                 "29881": "Orthopedics", "97140": "Physical Therapy", "80053": "Internal Medicine"}
    for k in range(18):
        a, b = rng.choice(EDIT_PAIRS)
        cands = [o for o in random_pool if o.specialty == pair_orgs[a] and o.kind != "SOLO_OON"]
        o = rng.choice(cands)
        payer = pick_payer(o)
        control = k >= 12
        lines = [{"code": a}, {"code": b, "mods": ["59"] if control else []}]
        cl = f.new_claim(day, o, payer, lines)
        if control:
            amt, _ = f.price_standard(cl, o)
            f.truth_row(cl, "I_UNBUNDLING_CONTROL", "STP", "", "AUTO_PRICED", amt, notes="modifier 59 bypass")
        else:
            amt, _ = f.price_standard(cl, o, overrides={2: Decimal("0.00")})
            f.truth_row(cl, "I_UNBUNDLING", "INTEGRITY", "UNBUNDLING", "DENY_COMPONENT_LINE", amt,
                        [{"line_no": 2, "action": "DENY_LINE"}], {"doc_type": "policy", "policy": "Code Pair Edit Policy"})
        scen_claims += 1

    # ---- I_UPCODING: 99215 from E/M outlier providers; visit note decides
    em_orgs = [o for o in orgs if "EM_OUTLIER" in o.flags]
    for k in range(10):
        o = rng.choice(em_orgs)
        payer = rng.choice(payer_ids)
        cl = f.new_claim(day, o, payer, [{"code": "99215"}])
        supports = k % 2 == 1
        if supports:
            amt, _ = f.price_standard(cl, o)
            decision, actions = "UPHOLD_LEVEL", []
        else:
            amt = standard_line(FS["99213"][2], 1, [], f.pct_for(payer, o))
            decision, actions = "DOWNCODE_TO_99213", [{"line_no": 1, "action": "RECODE", "to": "99213"}]
        f.truth_row(cl, "I_UPCODING", "INTEGRITY", "EM_LEVEL_REVIEW", decision, amt, actions,
                    {"doc_type": "visit_note", "field": "mdm_complexity"})
        f.attach(cl, "visit_note", {"high": supports, "provider": f.providers[cl["provider_id"]]["provider_name"],
                                    "service_date": cl["service_from"]}, scanned=rng.random() < 0.3)
        scen_claims += 1

    # ---- Y_BANK_CHANGE: payee changed bank account within 7 days via letter; legit vs suspicious
    bank_orgs = [o for o in orgs if "BANK_CHANGE" in o.flags][day * 8:(day + 1) * 8]
    for k, o in enumerate(bank_orgs):
        payer = rng.choice(payer_ids)
        cl = f.new_claim(day, o, payer, f.random_lines(o))
        legit = k % 2 == 0
        amt, _ = f.price_standard(cl, o)
        change_date = SIM_START + timedelta(days=day) - timedelta(days=rng.randint(1, 5))
        new_bank, new_state = rng.choice([b for b in BANKS if b[0] != o.bank["bank_name"]])
        o.bank_change = {"bank_name": new_bank, "bank_state": new_state if legit else rng.choice(["DE", "WY", "NV"]),
                         "routing_last4": f"{rng.randint(0, 9999):04d}", "account_last4": f"{rng.randint(0, 9999):04d}",
                         "effective_from": change_date.isoformat(), "legit": legit}
        f.truth_row(cl, "Y_BANK_CHANGE", "PAYMENT", "BANK_CHANGE_HOLD",
                    "RELEASE_AFTER_VERIFICATION" if legit else "HOLD_FRAUD_REVIEW", amt, [],
                    {"doc_type": "bank_change_letter", "field": "tin_match" if not legit else "callback_verified"})
        f.attach(cl, "bank_change_letter", {"org": o.name, "tin": o.tin if legit else tin(rng),
                                            "payee": o.name if legit else o.name.replace(",", "") + " Billing LLC",
                                            "legit": legit, **o.bank_change, "old_bank": o.bank["bank_name"]},
                 scanned=rng.random() < 0.5)
        scen_claims += 1

    # ---- noise attachments on clean claims (W-9s, itemized bills) so classification is real
    # ---- random clean claims for the remainder
    remaining = n_claims - scen_claims
    for k in range(remaining):
        if k % 40 == 0:
            o = rng.choice(hospitals)
        else:
            o = rng.choices(random_pool, weights=weights)[0]
        payer = pick_payer(o)
        lines = f.random_lines(o)
        cl = f.new_claim(day, o, payer, lines)
        # keep random claims below review thresholds
        c = f.contract_for(payer, o)
        if c is None and Decimal(cl["billed_amt"]) > 9000:
            continue_scale = Decimal("0.4")
            for ln in [x for x in f.lines if x["claim_id"] == cl["claim_id"]]:
                ln["billed_amt"] = str(money(Decimal(ln["billed_amt"]) * continue_scale))
            cl["billed_amt"] = str(money(sum(Decimal(x["billed_amt"]) for x in f.lines if x["claim_id"] == cl["claim_id"])))
        amt, _ = f.price_standard(cl, o)
        f.truth_row(cl, "CLEAN", "STP", "", "AUTO_PRICED", amt)
        if k % 45 == 7:
            f.attach(cl, "w9", {"org": o.name, "tin": o.tin, "state": o.state}, scanned=rng.random() < 0.5)


def write_csv(path: Path, rows: list[dict]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as fh:
        if not rows:
            return
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3)
    ap.add_argument("--claims-per-day", type=int, default=1200)
    ap.add_argument("--seed", type=int, default=20261026)
    ap.add_argument("--skip-docs", action="store_true")
    args = ap.parse_args()
    rng = random.Random(args.seed)

    orgs, providers, contracts = build_reference(rng)
    f = ClaimFactory(rng, orgs, providers, contracts)
    for d in range(args.days):
        generate_day(f, d, args.claims_per_day, orgs)

    t = OUT / "tables"
    write_csv(t / "payers.csv", [{"payer_id": p[0], "payer_name": p[1], "oon_pct": p[2], "oon_review_threshold": p[3],
                                  "oon_negotiate_threshold": p[4], "standard_pct": STANDARD_PCT[p[0]]} for p in PAYERS])
    write_csv(t / "fee_schedule.csv", [{"code": c[0], "description": c[1], "base_rate": f"{c[2]:.2f}",
                                        "bilateral_eligible": c[3], "category": c[4]} for c in FEE_SCHEDULE])
    write_csv(t / "edit_pairs.csv", [{"column1_code": a, "column2_code": b, "bypass_modifiers": "59,XS,XU"}
                                     for a, b in EDIT_PAIRS])
    write_csv(t / "provider_orgs.csv", [{"org_id": o.org_id, "org_name": o.name, "tin": o.tin, "specialty": o.specialty,
                                         "state": o.state, "network_kind": o.kind, "epay_enrolled": o.epay_enrolled,
                                         "pay_method": o.pay_method, "em_outlier": "EM_OUTLIER" in o.flags}
                                        for o in orgs])
    write_csv(t / "providers.csv", providers)
    banks = []
    for o in orgs:
        banks.append({"org_id": o.org_id, **o.bank, "change_source": "ENROLLMENT", "verified": True,
                      "effective_to": ""})
        if getattr(o, "bank_change", None):
            bc = o.bank_change
            banks[-1]["effective_to"] = bc["effective_from"]
            banks.append({"org_id": o.org_id, "bank_name": bc["bank_name"], "routing_last4": bc["routing_last4"],
                          "account_last4": bc["account_last4"], "bank_state": bc["bank_state"],
                          "effective_from": bc["effective_from"], "change_source": "LETTER", "verified": False,
                          "effective_to": ""})
    for i, b in enumerate(banks, 1):
        b["bank_account_id"] = f"BNK{i:04d}"
    write_csv(t / "bank_accounts.csv", banks)
    write_csv(t / "contracts.csv", [{"contract_id": c.contract_id, "payer_id": c.payer_id, "org_id": c.org_id or "",
                                     "contract_kind": "ORG" if c.org_id else "STANDARD", "pct_of_base": c.pct,
                                     "timely_filing_days": c.timely_filing_days, "payment_days": c.payment_days,
                                     "stop_loss_threshold": c.stop_loss_threshold or "",
                                     "stop_loss_pct": c.stop_loss_pct or "",
                                     "doc_file": f"{c.contract_id}.pdf"} for c in contracts])
    write_csv(t / "contract_carveouts.csv", [{"contract_id": c.contract_id, "code": cv["code"],
                                              "rate_type": cv["rate_type"], "rate": cv.get("rate", ""),
                                              "pct": cv.get("pct", ""), "markup_pct": cv.get("markup_pct", ""),
                                              "cap_mult": cv.get("cap_mult", ""), "source_section": cv["source"]}
                                             for c in contracts for cv in c.carveouts])
    write_csv(t / "claims_source.csv", f.claims)
    write_csv(t / "claim_lines_source.csv", f.lines)
    write_csv(t / "attachments_source.csv", [{k: v for k, v in a.items() if k != "payload"} for a in f.attachments])
    write_csv(t / "ground_truth.csv", f.truth)

    if not args.skip_docs:
        docs.render_all(OUT, orgs, providers, contracts, f, PAYERS, FS)

    from collections import Counter
    print("claims", len(f.claims), "lines", len(f.lines), "attachments", len(f.attachments))
    print("routes", Counter(r["expected_route"] for r in f.truth))
    print("scenarios", Counter(r["scenario"] for r in f.truth))


if __name__ == "__main__":
    main()
