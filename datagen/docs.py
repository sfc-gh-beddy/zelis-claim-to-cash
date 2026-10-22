"""Render contracts, payer policies and claim attachments to PDF.

Scanned attachments are rasterised, skewed, noised and JPEG-compressed into an
image-only PDF so AI_PARSE_DOCUMENT has to OCR them (no text layer).
"""
from __future__ import annotations

import io
import random
from decimal import Decimal
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageFilter
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from pricing_spec import money

SS = getSampleStyleSheet()
H1 = ParagraphStyle("h1", parent=SS["Heading1"], fontSize=15, spaceAfter=8)
H2 = ParagraphStyle("h2", parent=SS["Heading2"], fontSize=11.5, spaceBefore=8, spaceAfter=4)
P = ParagraphStyle("p", parent=SS["BodyText"], fontSize=9.5, leading=12.5)
SMALL = ParagraphStyle("s", parent=P, fontSize=8, textColor=colors.grey)


def _pdf(path: Path, story, scanned=False, seed=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=LETTER, leftMargin=0.8 * inch, rightMargin=0.8 * inch,
                      topMargin=0.7 * inch, bottomMargin=0.7 * inch).build(story)
    data = buf.getvalue()
    if not scanned:
        path.write_bytes(data)
        return
    rng = np.random.default_rng(seed)
    pages = []
    for page in pdfium.PdfDocument(data):
        img = page.render(scale=150 / 72).to_pil().convert("L")
        img = img.rotate(float(rng.uniform(-1.6, 1.6)), expand=True, fillcolor=245)
        arr = np.asarray(img).astype(np.int16)
        arr = arr + rng.normal(0, 14, arr.shape).astype(np.int16)
        speckle = rng.random(arr.shape) < 0.0025
        arr[speckle] = 40
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
        jb = io.BytesIO()
        img.save(jb, "JPEG", quality=38)
        pages.append(Image.open(io.BytesIO(jb.getvalue())).convert("RGB"))
    pages[0].save(path, "PDF", save_all=True, append_images=pages[1:], resolution=150)


def _table(rows, widths, header=True):
    t = Table(rows, colWidths=widths)
    style = [("FONTSIZE", (0, 0), (-1, -1), 8.5), ("GRID", (0, 0), (-1, -1), 0.4, colors.grey),
             ("VALIGN", (0, 0), (-1, -1), "TOP")]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF4")), ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold")]
    t.setStyle(TableStyle(style))
    return t


# ------------------------------------------------------------------ contracts
def contract_pdf(path, c, org, payer, FS):
    s = [Paragraph(f"PROVIDER SERVICES AGREEMENT  {c.contract_id}", H1),
         Paragraph(f"between <b>{payer[1]}</b> (\"Plan\") and <b>{org.name}</b>, TIN {org.tin} (\"Provider\"). "
                   "Synthetic agreement prepared for demonstration; not a real contract.", SMALL), Spacer(1, 6)]
    sec = [
        ("1. Term", "This Agreement is effective January 1, 2025 and renews annually unless terminated by either party "
                    "on ninety (90) days written notice."),
        ("2. Definitions", "\"Reference Base Rate\" means the Plan's published reference rate for a code as listed in the "
                           "Plan fee schedule in effect on the date of service. \"Eligible Charges\" means billed charges "
                           "less charges for non-covered items, including personal comfort items, take-home supplies, "
                           "and services excluded under the member's benefit plan."),
        ("3. Covered Services", f"Provider shall render {org.specialty.lower()} services to Plan members within the scope "
                                "of Provider's licensure."),
        ("4. Compensation",
         f"4.1 Except as otherwise provided in this Agreement, Plan shall reimburse Covered Services at "
         f"<b>{c.pct}% of the Reference Base Rate</b>, adjusted for applicable modifiers under the Plan's modifier "
         "payment policy, not to exceed billed charges on a claim basis. "
         + ("<br/>4.2 Implantable devices (HCPCS C1776 and L8699) shall be reimbursed at the manufacturer invoice cost "
            "plus ten percent (10%), not to exceed three times (3x) the Reference Base Rate per unit. Provider shall "
            "submit the manufacturer invoice with the claim." if any(cv['code'] in ('C1776', 'L8699') for cv in c.carveouts) else "")),
    ]
    if c.stop_loss_threshold:
        sec.append(("5. Stop-Loss", f"When billed charges for an inpatient or surgical claim exceed "
                                    f"${c.stop_loss_threshold:,.0f}, the entire claim shall be reimbursed at "
                                    f"<b>{c.stop_loss_pct}% of Eligible Charges</b> in lieu of Section 4. Provider "
                                    "shall submit an itemized bill identifying non-covered items."))
    else:
        sec.append(("5. Stop-Loss", "Not applicable."))
    prec = ("In the event of a conflict between the body of this Agreement and any Exhibit, <b>the body of this "
            "Agreement shall control</b>." if c.precedence == "BODY" else
            "In the event of a conflict between the body of this Agreement and any Exhibit, <b>the terms of the "
            "Exhibit shall control</b> as the more specific provision.")
    sec += [("6. Order of Precedence", prec),
            ("7. Timely Filing", f"Claims must be submitted within {c.timely_filing_days} days of the date of service."),
            ("8. Payment", f"Plan shall pay clean claims within {c.payment_days} days of receipt by electronic funds "
                           "transfer to the account on file, or by virtual card where Provider has elected it.")]
    for h, body in sec:
        s += [Paragraph(h, H2), Paragraph(body, P)]
    exhibit = [cv for cv in c.carveouts if cv["source"] == "EXHIBIT A"]
    s += [Paragraph("Exhibit A - Code-Specific Rates", H2)]
    if exhibit:
        rows = [["Code", "Description", "Reimbursement"]]
        for cv in exhibit:
            if cv["rate_type"] == "FLAT":
                r = f"${cv['rate']:,.2f} per unit (case rate)"
            else:
                r = f"{cv['pct']}% of Reference Base Rate"
            rows.append([cv["code"], Paragraph(FS[cv["code"]][1], P), r])
        s.append(_table(rows, [0.8 * inch, 3.6 * inch, 2.2 * inch]))
    else:
        s.append(Paragraph("No code-specific rates.", P))
    s += [Spacer(1, 14), Paragraph("Signed for Plan: ______________________   Signed for Provider: ______________________", P)]
    _pdf(path, s)


POLICIES = {
    "POL_OON": ("Out-of-Network Reimbursement Policy", [
        ("Scope", "Applies to claims from providers with no participation agreement with the Plan."),
        ("Reimbursement", "Out-of-network claims are reimbursed at the payer's out-of-network percentage of the Reference "
                          "Base Rate: Meridian Health Plan 140%, Cascade Benefit Trust 125%, Lakeshore Employers TPA 150%, "
                          "Summit Mutual Health 130%. The allowed amount never exceeds billed charges on a claim basis."),
        ("Review threshold", "Claims with billed charges above $10,000 require pricing review before payment. Where billed "
                             "charges are between $10,000 and $25,000 the reviewer shall price at the out-of-network "
                             "percentage."),
        ("Negotiation", "Where billed charges exceed $25,000 the reviewer shall issue a written offer at the "
                        "out-of-network policy amount and route the claim to negotiation. The offer amount is the "
                        "amount payable if accepted. Do not pay billed charges."),
    ]),
    "POL_EDITS": ("Code Pair Edit Policy", [
        ("Scope", "Applies to code pairs listed in the Plan's edit table where the column 2 code is a component of the "
                  "column 1 procedure."),
        ("Rule", "When both codes are billed for the same date of service without a distinct-procedure modifier (59, "
                 "XS or XU), the column 2 line is denied as included in the column 1 procedure. The column 1 line is "
                 "paid normally."),
        ("Bypass", "A distinct-procedure modifier indicates a separate site or session and permits separate payment."),
    ]),
    "POL_MODIFIERS": ("Modifier Payment Policy", [
        ("Bilateral (50)", "Procedures performed bilaterally are reported on one line with modifier 50 and one unit, and "
                           "are reimbursed at 150% of the single-procedure allowance."),
        ("Bilateral without modifier", "When a bilateral-eligible code is billed with two units and no modifier 50, the "
                                       "reviewer shall check the operative or procedure note. If both sides were "
                                       "treated, re-price with modifier 50 (one unit at 150%). If the note documents a "
                                       "single side with two units for a separate reason, price as billed."),
        ("Multiple procedure (51)", "Secondary procedures are reimbursed at 50%."),
        ("Professional/technical (26/TC)", "Professional component 40%; technical component 60%."),
    ]),
    "POL_EM": ("E/M Level Documentation Policy", [
        ("Level 5 (99215)", "Requires high-complexity medical decision making: for example, one or more chronic illnesses "
                            "with severe exacerbation, drug therapy requiring intensive monitoring for toxicity, or a "
                            "decision regarding hospitalization."),
        ("Recoding", "When the visit note documents low-complexity decision making (for example, one stable chronic "
                     "illness, routine medication refill), the line is recoded to 99213 and priced accordingly."),
        ("Outlier review", "Providers whose level-5 share exceeds 30% of established-patient visits are subject to "
                           "pre-payment review of 99215 claims."),
    ]),
    "POL_DUP": ("Duplicate and Corrected Claim Policy", [
        ("Exact duplicate", "A claim with frequency code 1 matching a previously received claim on provider, member, "
                            "date of service and codes is denied as a duplicate."),
        ("Corrected claim", "A claim with frequency code 7 replaces the original claim. The original is voided and the "
                            "corrected claim is priced and paid in its place."),
    ]),
    "POL_BANK": ("Payee Bank Account Change Policy", [
        ("Hold", "Payments to a bank account changed within the last 7 days by letter or phone are held until the "
                 "change is verified."),
        ("Verification", "Verification requires a call-back to the phone number already on file (never a number in the "
                         "change request) confirming the request, and a match of payee legal name and TIN to the "
                         "provider record."),
        ("Red flags", "Payee name that differs from the provider's legal name, TIN mismatch, out-of-state bank with no "
                      "business presence, urgency language, or a personal email domain. Any red flag keeps the hold "
                      "and routes to fraud review; do not release."),
    ]),
    "POL_APPROVAL": ("Payment Release Approval Matrix", [
        ("Payment Approver", "May approve payment batches up to $250,000 total and individual claims up to $50,000."),
        ("Payments Operations Lead", "May approve any batch or claim amount and release held payments after "
                                     "verification."),
        ("Segregation of duties", "The person who resolves an exception may not approve the batch containing it."),
    ]),
    "POL_RAILS": ("Payment Rails and Cut-off Policy", [
        ("ACH", "Same-day ACH batches released before 2:45 PM ET settle the same business day."),
        ("Virtual card", "Virtual card payments are delivered to the provider portal on release."),
        ("Check", "Checks are printed next business day; providers not enrolled in electronic payment should be offered "
                  "ACH or virtual card enrollment."),
    ]),
}


def policy_pdf(path, title, sections):
    s = [Paragraph(title, H1), Paragraph("Synthetic payer policy for demonstration.", SMALL), Spacer(1, 6)]
    for h, body in sections:
        s += [Paragraph(h, H2), Paragraph(body, P)]
    _pdf(path, s)


# ------------------------------------------------------------------ attachments
def operative_note(a, rng):
    p = a["payload"]
    side = rng.choice(["left", "right"])
    if p["bilateral"]:
        findings = (f"The procedure ({p['desc'].lower()}) was performed on the <b>right side and then the left side</b> "
                    "in the same session. Both sides were prepped and draped separately. Bilateral procedure.")
    else:
        findings = (f"The procedure ({p['desc'].lower()}) was performed on the <b>{side} side only</b>. "
                    f"Two units reflect two separate injection sites on the {side} side; the contralateral side was not "
                    "treated.")
    return [Paragraph("OPERATIVE / PROCEDURE NOTE", H1),
            Paragraph(f"Date of service: {p['service_date']} &nbsp;&nbsp; Surgeon: {p['provider']}", P),
            Paragraph(f"Procedure code reported: {p['code']}", P), Spacer(1, 6),
            Paragraph("Indication", H2), Paragraph("Chronic pain refractory to conservative management.", P),
            Paragraph("Procedure details", H2), Paragraph(findings, P),
            Paragraph("Complications", H2), Paragraph("None. Patient tolerated the procedure well.", P)]


def implant_invoice(a, rng):
    p = a["payload"]
    total = Decimal(p["invoice_total"])
    n = rng.randint(1, 3)
    parts = [money(total / n)] * (n - 1)
    parts.append(total - sum(parts))
    rows = [["Item", "Lot", "Qty", "Unit cost", "Extended"]]
    for i, amt in enumerate(parts):
        rows.append([f"{p['code']} component {i + 1}", f"LT{rng.randint(100000, 999999)}", "1", f"${amt:,.2f}",
                     f"${amt:,.2f}"])
    rows.append(["", "", "", "INVOICE TOTAL", f"${total:,.2f}"])
    return [Paragraph(f"{p['vendor']}", H1), Paragraph("COMMERCIAL INVOICE", H2),
            Paragraph(f"Invoice #: INV-{rng.randint(100000, 999999)} &nbsp; Ship to: {p['facility']} &nbsp; "
                      f"Case date: {p['service_date']}", P), Spacer(1, 6),
            _table(rows, [2.2 * inch, 1.0 * inch, 0.5 * inch, 1.3 * inch, 1.3 * inch]),
            Spacer(1, 6), Paragraph("Terms: Net 30. Prices reflect contracted device pricing.", SMALL)]


def itemized_bill(a, rng):
    p = a["payload"]
    billed, nonc = Decimal(p["billed_total"]), Decimal(p["non_covered"])
    nc_items = [("0990", "Personal comfort items (TV, phone)"), ("0253", "Take-home pharmacy supplies"),
                ("0270", "Convenience kit - not medically necessary")]
    nc_parts = [money(nonc * Decimal("0.35")), money(nonc * Decimal("0.4"))]
    nc_parts.append(nonc - sum(nc_parts))
    covered = billed - nonc
    cov_items = [("0120", "Room and board - semi-private"), ("0360", "Operating room services"),
                 ("0250", "Pharmacy"), ("0300", "Laboratory"), ("0350", "CT scan"), ("0450", "Emergency room")]
    weights = [0.42, 0.28, 0.1, 0.05, 0.08]
    cov_parts = [money(covered * Decimal(str(w))) for w in weights]
    cov_parts.append(covered - sum(cov_parts))
    rows = [["Rev code", "Description", "Charge", "Covered?"]]
    items = [(c, d, v, "Y") for (c, d), v in zip(cov_items, cov_parts)] + \
            [(c, d, v, "N - non-covered") for (c, d), v in zip(nc_items, nc_parts)]
    rng.shuffle(items)
    for c, d, v, cov in items:
        rows.append([c, d, f"${v:,.2f}", cov])
    rows += [["", "TOTAL BILLED CHARGES", f"${billed:,.2f}", ""], ["", "TOTAL NON-COVERED", f"${nonc:,.2f}", ""]]
    return [Paragraph(f"{p['facility']}", H1), Paragraph("ITEMIZED STATEMENT OF CHARGES", H2),
            Paragraph(f"Admission date: {p['service_date']} &nbsp; Account: {rng.randint(10000000, 99999999)}", P),
            Spacer(1, 6), _table(rows, [0.8 * inch, 3.3 * inch, 1.3 * inch, 1.3 * inch])]


def visit_note(a, rng):
    p = a["payload"]
    if p["high"]:
        a_p = ("1. Type 2 diabetes with severe exacerbation, glucose 412, ketones positive. 2. CKD stage 4. "
               "Started insulin infusion protocol; drug therapy requiring intensive monitoring for toxicity. "
               "Discussed hospital admission; patient agreed to direct admission if not improved in 6 hours.")
        hpi = "Patient presents with 3 days of polyuria, vomiting and confusion. Known poorly controlled diabetes."
    else:
        a_p = ("1. Essential hypertension, stable on current regimen. Refilled lisinopril 10 mg. "
               "No medication changes. Return in 6 months.")
        hpi = "Patient presents for routine follow-up of hypertension. No complaints. Home readings 120s/70s."
    return [Paragraph("OFFICE VISIT NOTE", H1),
            Paragraph(f"Date of service: {p['service_date']} &nbsp; Provider: {p['provider']} &nbsp; "
                      "Level billed: 99215", P), Spacer(1, 6),
            Paragraph("History of present illness", H2), Paragraph(hpi, P),
            Paragraph("Exam", H2), Paragraph("Vitals reviewed. Exam documented per template.", P),
            Paragraph("Assessment and plan", H2), Paragraph(a_p, P)]


def bank_change_letter(a, rng):
    p = a["payload"]
    contact = ("billing@" + p["org"].split()[0].lower() + "health.org") if p["legit"] else \
              f"{p['payee'].split()[0].lower()}.payments{rng.randint(10, 99)}@gmail.com"
    urgency = "" if p["legit"] else ("<b>URGENT:</b> our previous account has been closed. Please update before your "
                                     "next payment run to avoid returned payments. ")
    body = (f"{urgency}Please update the electronic funds transfer account on file for payments to "
            f"<b>{p['payee']}</b>, TIN <b>{p['tin']}</b>. Previous bank: {p['old_bank']}. "
            f"New bank: <b>{p['bank_name']}</b> ({p['bank_state']}), routing ending {p['routing_last4']}, account "
            f"ending {p['account_last4']}, effective {p['effective_from']}.")
    callback = ("Verification: confirmed by return call to the number on file." if p["legit"] else
                f"To confirm, call our new billing office at (555) {rng.randint(200, 999)}-{rng.randint(1000, 9999)}.")
    return [Paragraph(p["org"], H1), Paragraph("Request to Change Payment Account", H2), Spacer(1, 6),
            Paragraph("To: Provider Payments Department", P), Spacer(1, 4), Paragraph(body, P), Spacer(1, 4),
            Paragraph(callback, P), Spacer(1, 10), Paragraph(f"Contact: {contact}", P),
            Paragraph("Authorized signature: ______________________", P)]


def w9(a, rng):
    p = a["payload"]
    return [Paragraph("Request for Taxpayer Identification Number and Certification (synthetic W-9)", H1),
            _table([["Name", p["org"]], ["Federal tax classification", "C Corporation"], ["TIN", p["tin"]],
                    ["State", p["state"]]], [2.2 * inch, 4.2 * inch], header=False),
            Spacer(1, 8), Paragraph("Under penalties of perjury, I certify that the information is correct.", P)]


RENDERERS = {"operative_note": operative_note, "implant_invoice": implant_invoice, "itemized_bill": itemized_bill,
             "visit_note": visit_note, "bank_change_letter": bank_change_letter, "w9": w9}


def render_all(out: Path, orgs, providers, contracts, f, PAYERS, FS):
    rng = random.Random(7)
    orgs_by = {o.org_id: o for o in orgs}
    payer_by = {p[0]: p for p in PAYERS}
    for c in contracts:
        if c.org_id:
            contract_pdf(out / "docs" / f"{c.contract_id}.pdf", c, orgs_by[c.org_id], payer_by[c.payer_id], FS)
        else:
            s = [Paragraph(f"STANDARD PARTICIPATION AGREEMENT  {c.contract_id}", H1),
                 Paragraph(f"{payer_by[c.payer_id][1]} standard terms for individually participating practitioners. "
                           "Synthetic agreement prepared for demonstration.", SMALL),
                 Paragraph("4. Compensation", H2),
                 Paragraph(f"Covered Services are reimbursed at <b>{c.pct}% of the Reference Base Rate</b>, adjusted "
                           "for applicable modifiers under the Plan's modifier payment policy, not to exceed billed "
                           "charges on a claim basis.", P),
                 Paragraph("8. Payment", H2), Paragraph(f"Clean claims are paid within {c.payment_days} days.", P)]
            _pdf(out / "docs" / f"{c.contract_id}.pdf", s)
    for pid, (title, secs) in POLICIES.items():
        policy_pdf(out / "docs" / f"{pid}.pdf", title, secs)
    for i, a in enumerate(f.attachments):
        _pdf(out / "attachments" / a["file_name"], RENDERERS[a["true_doc_type"]](a, rng), scanned=a["scanned"], seed=i)
