"""
Combines Bolagsverket's bulk export with SCB's bulk export into a CSV ready
for \\copy into company_registry_cache -- see load_registry_cache.sql for
that step.

Bolagsverket supplies: org_number, name, company_form, address, city, zip,
registered_at, business_description (verksamhetsbeskrivning -- free text the
company writes about itself).

SCB supplies: sni_code (Ng1), no_marketing (Reklamsparrtyp).

industry_label is derived from sni_code via an SNI 2025 code list, so it
holds the same kind of official label the live tier-3 lookup writes.

company_registry_cache has no columns for deregistration/liquidation/activity
status -- those values are still captured, just inside the `raw` jsonb blob
instead of their own columns.

USAGE:
    1. Point BOLAGSVERKET_FILE and SCB_FILE below at your two downloaded files.
    2. Optionally save an SNI code list as sni_2025_koder.csv (see below).
    3. python build_registry_cache_csv.py
"""

import csv
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
BOLAGSVERKET_FILE = SCRIPT_DIR / "bolagsverket_bulkfil.txt"
SCB_FILE = SCRIPT_DIR / "scb_bulkfil.txt"
OUTPUT_FILE = SCRIPT_DIR / "company_registry_cache_import_2.csv"

# OPTIONAL. Maps SNI codes to their official labels, so industry_label holds
# the same kind of value the live tier-3 lookup writes (sni[0].klartext)
# rather than free text. Download the SNI 2025 code list from SCB's
# Klassifikationsdatabas and save it as a two-column file: code, label.
# Separator may be comma, semicolon or tab; a header row is fine.
#
# Without this file the script still runs -- industry_label is simply left
# NULL for every bulk row, and gets filled in per company by tier-3 later.
SNI_LOOKUP_FILE = SCRIPT_DIR / "sni_2025_koder.csv"

# Reklamsparrtyp, per SCB's published variable documentation -- note this
# reads the opposite way round to how the column is named, so it's easy to
# invert by accident:
#     1 = företaget har INTE frånsagt sig reklam  -> no_marketing = false
#     2 = företaget HAR frånsagt sig reklam       -> no_marketing = true
NO_MARKETING_REKLAMSPARR_CODES = {"2"}

# A blank Reklamsparrtyp becomes NULL rather than false, matching how the
# live edge function treats a missing JA/NEJ (janejToBoolean returns null).

# Bulk rows are a baseline, NOT a fetch from Bolagsverket's API. Left to the
# column default of now(), every imported company would count as fresh under
# the edge function's FRESHNESS_WINDOW_MS and would not get a live lookup for
# a full 30 days. Backdating makes the first lookup on any company go live,
# which is the intended behaviour.
BULK_LAST_FETCHED_AT = "1970-01-01T00:00:00Z"

OUTPUT_COLUMNS = [
    "org_number",
    "name",
    "company_form",
    "sni_code",
    "industry_label",
    "business_description",
    "address",
    "city",
    "zip",
    "no_marketing",
    "registered_at",
    "last_fetched_at",
    "raw",
]


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def sanitize(value):
    """Postgres cannot store a literal null byte in text/jsonb columns, and
    some rows use the literal string "null" as a placeholder rather than
    leaving a field empty -- which breaks COPY on typed columns.

    Rows with more fields than the header declares arrive as a list under the
    None key (usually a stray unescaped quote in a free-text field), so those
    are joined back into a string rather than crashing."""
    if isinstance(value, list):
        value = ";".join(v for v in value if v)
    if isinstance(value, str):
        value = value.replace("\x00", "")
        if value.strip().lower() == "null":
            return ""
    return value


def sanitize_row(row):
    return {key: sanitize(value) for key, value in row.items()}


def to_pg_bool(value):
    return "true" if value else "false"


# ---------------------------------------------------------------------------
# Bolagsverket file
# ---------------------------------------------------------------------------

def code_only(value):
    """'S-ORGFO' -> 'S'   'VERKUPP-AVORG' -> 'VERKUPP'"""
    if not value:
        return None
    return value.rsplit("-", 1)[0] if "-" in value else value


def parse_org_number(value):
    """'8888006577$ORGNR-IDORG' -> '8888006577'"""
    if not value:
        return None
    return value.split("$")[0] or None


def parse_name(value):
    """'Acme AB$FORETAGSNAMN-ORGNAM$1993-03-15' -> ('Acme AB', 'FORETAGSNAMN', '1993-03-15')"""
    if not value:
        return None, None, None
    parts = value.split("$")
    name = parts[0] or None
    name_type = code_only(parts[1]) if len(parts) > 1 else None
    name_date = parts[2] if len(parts) > 2 and parts[2] else None
    return name, name_type, name_date


def parse_address(value):
    """'Storgatan 100$$SOLLEFTEA$88140$SE-LAND' -> ('Storgatan 100', 'SOLLEFTEA', '88140')"""
    if not value:
        return None, None, None
    parts = value.split("$")
    if len(parts) < 3:
        return value, None, None
    zip_code = parts[-2] or None
    city = parts[-3] or None
    address = ", ".join(p for p in parts[:-3] if p) or None
    return address, city, zip_code


def selection_key(record):
    """Companies appear on several rows -- one per registered name, past and
    present. Prefer the current registered name (FORETAGSNAMN), and among
    those the most recently dated. ISO dates sort correctly as strings."""
    return (record["name_type"] == "FORETAGSNAMN", record["name_date"] or "")


def process_bolagsverket_row(row):
    org_number = parse_org_number(row.get("organisationsidentitet"))
    name, name_type, name_date = parse_name(row.get("organisationsnamn"))
    address, city, zip_code = parse_address(row.get("postadress"))

    return {
        "org_number": org_number,
        "name": name,
        "name_type": name_type,  # selection only, not written out
        "name_date": name_date,  # selection only, not written out
        "company_form": code_only(row.get("organisationsform")),
        # Free text the company writes about itself. NOT an industry
        # classification -- industry_label is derived from SCB's Ng1 via the
        # SNI lookup instead, matching what tier-3 writes.
        "business_description": row.get("verksamhetsbeskrivning") or None,
        "address": address,
        "city": city,
        "zip": zip_code,
        "registered_at": row.get("registreringsdatum") or None,
        "bolagsverket_raw": {
            "organisationsidentitet_raw": row.get("organisationsidentitet"),
            "namnskyddslopnummer": row.get("namnskyddslopnummer") or None,
            "registreringsland": row.get("registreringsland") or None,
            "organisationsnamn_raw": row.get("organisationsnamn"),
            "organisationsform_raw": row.get("organisationsform"),
            # No output columns for these anymore -- kept raw so they're
            # recoverable without re-running the whole pipeline.
            "avregistreringsdatum_raw": row.get("avregistreringsdatum") or None,
            "avregistreringsorsak_raw": row.get("avregistreringsorsak"),
            "pagaende_avveckling_raw": row.get(
                "pagandeAvvecklingsEllerOmstruktureringsforfarande"
            ),
            "postadress_raw": row.get("postadress"),
        },
    }


def load_bolagsverket():
    best_by_org = {}
    skipped = 0
    duplicates = 0

    with open(BOLAGSVERKET_FILE, encoding="utf-8-sig", errors="replace", newline="") as infile:
        for row in csv.DictReader(infile, delimiter=";"):
            record = process_bolagsverket_row(sanitize_row(row))
            org_number = record["org_number"]

            if not org_number:
                skipped += 1
                continue

            existing = best_by_org.get(org_number)
            if existing is not None:
                duplicates += 1
                if selection_key(record) <= selection_key(existing):
                    continue

            best_by_org[org_number] = record

    print(f"Bolagsverket: {len(best_by_org)} unique org numbers")
    print(f"  skipped {skipped} rows with no org number")
    print(f"  saw {duplicates} repeated org numbers (kept the best row for each)")
    return best_by_org


# ---------------------------------------------------------------------------
# SCB file
# ---------------------------------------------------------------------------

def normalize_pe_org_nr(value):
    """SCB prefixes its 12-digit PeOrgNr; Bolagsverket does not use the same
    form, so these must be normalized before they'll match anything:

      '16' + 10-digit org number  -> strip to the 10 digits
      '19'/'20' + personnummer    -> keep all 12 digits, which is exactly how
                                     Bolagsverket writes them
                                     ('196406253432$PERSON-IDORG')

    Joining on the raw value fails silently -- zero matches, no error -- so
    this is the single most important function in the SCB half of the script.
    """
    if not value:
        return None
    digits = value.strip()
    if len(digits) == 12 and digits.startswith("16"):
        return digits[2:]
    return digits or None


def scb_flag(value, true_codes):
    """Empty -> None (NULL, "we don't know"), matching the live lookup's
    handling of a missing JA/NEJ. Otherwise true/false per the codelist."""
    if value is None or value == "":
        return None
    return to_pg_bool(value in true_codes)


def load_scb():
    """Returns {org_number: (sni_code, no_marketing, extras)}.
    Deliberately compact -- this sits in memory alongside the much larger
    Bolagsverket dict, so it holds only what's actually used."""
    by_org = {}
    unreadable = 0

    with open(SCB_FILE, encoding="utf-8-sig", errors="replace", newline="") as infile:
        for row in csv.DictReader(infile, delimiter="\t"):
            row = sanitize_row(row)
            org_number = normalize_pe_org_nr(row.get("PeOrgNr"))
            if not org_number:
                unreadable += 1
                continue

            extra_ng = [row.get(f"Ng{i}") for i in range(2, 6)]
            by_org[org_number] = (
                row.get("Ng1") or None,
                scb_flag(row.get("Reklamsparrtyp"), NO_MARKETING_REKLAMSPARR_CODES),
                {
                    "jur_form": row.get("JurForm") or None,  # SCB's codelist, NOT Bolagsverket's
                    "foretagsnamn": row.get("Foretagsnamn") or None,
                    "co_adress": row.get("COAdress") or None,
                    "je_stat": row.get("JEStat") or None,
                    "ftg_stat_raw": row.get("FtgStat") or None,  # activity status, no output column anymore
                    "ng_ovriga": [c for c in extra_ng if c] or None,
                },
            )

    print(f"SCB: {len(by_org)} rows keyed by org number")
    if unreadable:
        print(f"  skipped {unreadable} rows with an unreadable PeOrgNr")
    return by_org


# ---------------------------------------------------------------------------
# Merge and write
# ---------------------------------------------------------------------------

def normalize_sni_code(value):
    """SNI codes appear variously as '64994', '64.994' or '64.99.4'. Reduce
    to bare digits so the lookup matches regardless of formatting."""
    if not value:
        return None
    digits = "".join(ch for ch in value if ch.isdigit())
    return digits or None


def load_sni_labels():
    """Reads SNI_LOOKUP_FILE into {code: label}. Expects two columns, code
    first. Sniffs the separator and skips a header row if one is present.
    Returns an empty dict if the file isn't there."""
    if not SNI_LOOKUP_FILE.exists():
        print(f"No SNI lookup at {SNI_LOOKUP_FILE.name} -- industry_label will be NULL")
        return {}

    labels = {}
    with open(SNI_LOOKUP_FILE, encoding="utf-8-sig", errors="replace", newline="") as infile:
        sample = infile.read(4096)
        infile.seek(0)
        delimiter = max([",", ";", "\t"], key=sample.count)

        for row in csv.reader(infile, delimiter=delimiter):
            if len(row) < 2:
                continue
            code = normalize_sni_code(row[0])
            label = row[1].strip()
            # Skips the header row for free: a header's first cell has no digits.
            if code and label:
                labels[code] = label

    print(f"SNI lookup: {len(labels)} codes")
    return labels

def clean_text(val):
    if not isinstance(val, str):
        return val
    # Strip out newlines and carriage returns that break CSV rows
    val = val.replace("\n", " ").replace("\r", " ")
    # Clean up chaotic backslash-quote artifacts common in Swedish bulk exports
    val = val.replace('\\"', '"').replace('\\\\', '\\')
    return val

def clean_dict_values(val):
    if isinstance(val, dict):
        return {k: clean_dict_values(v) for k, v in val.items()}
    elif isinstance(val, list):
        return [clean_dict_values(v) for v in val]
    elif isinstance(val, str):
        return clean_text(val)
    return val

def build_row(org_number, record, scb_match, sni_labels):
    """Merges one Bolagsverket record with its SCB match (if any) into an
    OUTPUT_COLUMNS-shaped row. Returns (row, matched, labelled) so main() can
    tally stats without recomputing anything."""
    sni_code = no_marketing = None
    scb_extras = None
    if scb_match is not None:
        sni_code, no_marketing, scb_extras = scb_match

    industry_label = sni_labels.get(normalize_sni_code(sni_code)) if sni_code else None

    raw = record["bolagsverket_raw"]
    if scb_extras:
        raw = {**raw, "scb": scb_extras}
    raw_json_str = json.dumps(clean_dict_values(raw), ensure_ascii=False)

    row = [
        org_number,
        clean_text(record["name"]),
        clean_text(record["company_form"]),
        sni_code,
        clean_text(industry_label) if industry_label else "",
        clean_text(record["business_description"]),
        clean_text(record["address"]),
        clean_text(record["city"]),
        clean_text(record["zip"]),
        no_marketing if no_marketing is not None else "",
        record["registered_at"],
        BULK_LAST_FETCHED_AT,
        raw_json_str,
    ]
    return row, scb_match is not None, bool(industry_label)


def main():
    for path in (BOLAGSVERKET_FILE, SCB_FILE):
        if not path.exists():
            print(f"Could not find:\n  {path}")
            print("Check the filename matches and that it sits next to this script.")
            sys.exit(1)

    bolagsverket = load_bolagsverket()
    scb = load_scb()
    sni_labels = load_sni_labels()

    enriched = labelled = 0

    with open(OUTPUT_FILE, "w", encoding="utf-8", newline="") as outfile:
        writer = csv.writer(outfile)
        writer.writerow(OUTPUT_COLUMNS)

        for org_number, record in bolagsverket.items():
            row, matched, has_label = build_row(org_number, record, scb.get(org_number), sni_labels)
            writer.writerow(row)
            enriched += matched
            labelled += has_label

    total = len(bolagsverket)
    print(f"\nWrote {total} rows to {OUTPUT_FILE.name}")
    print(f"  {enriched} matched an SCB row and carry sni_code/no_marketing")
    print(f"  {total - enriched} had no SCB match")
    print(f"  {labelled} resolved an industry_label from their SNI code")
    print(f"  {len(scb) - enriched} SCB rows matched nothing in the Bolagsverket file")


if __name__ == "__main__":
    main()