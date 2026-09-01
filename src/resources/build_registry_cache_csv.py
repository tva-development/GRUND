"""
Slår ihop Bolagsverkets bulkfil med SCB:s bulkfil till en CSV som läses in i
company_registry_cache.

Bolagsverket ger:  org_number, name, company_form, address, city, zip,
                   registered_at, deregistered_at, deregistration_reason,
                   in_liquidation, business_description
SCB ger:           sni_code (Ng1), is_active (FtgStat), no_marketing
                   (Reklamsparrtyp), samt en andra adress och SCB:s eget namn

industry_label härleds ur sni_code via SNI 2025-listan, så kolumnen håller
samma sorts officiella etikett som den live tier 3-lookupen skriver.

FAKTA OM FILERNA — mätt på skarp data, inte antaget:
  * Bolagsverket: ";"-separerad, äkta UTF-8 (0 ogiltiga sekvenser i hela
    filen på 984 MB). 2 970 586 rader, 2 861 310 unika org-nummer.
  * SCB: TAB-separerad och LATIN-1, inte UTF-8. Läses den som UTF-8 blir
    varje Å/Ä/Ö ett ersättningstecken — 600 762 av dem bara i de första
    50 MB. 1 817 615 rader, PeOrgNr är unikt (inga dubbletter).
  * SCB:s "Foretagsnamn" är TOMT i 87,9 % av raderna. Namnet ligger i
    "Namn", som alltid är ifyllt.
  * 60,6 % av Bolagsverkets org-nummer är avregistrerade. 99,5 % av de som
    INTE är avregistrerade matchar en SCB-rad — dvs de omatchade raderna är
    i praktiken exakt de döda bolagen.
  * Reklamsparrtyp är ensiffrig: 1 (99,7 %) och 2 (0,3 %).

ANVÄNDNING:
    python build_registry_cache_csv.py [mapp-med-bulkfilerna]

Utan argument letas filerna bredvid skriptet. Bulkfilerna är tillsammans
1,2 GB och CSV:n blir ett par hundra MB, så de hör inte hemma i repot — peka
i stället på var de ligger:

    python src/resources/build_registry_cache_csv.py ~/Downloads/script

SNI-listan (sni_2025_koder.csv) läses alltid bredvid skriptet, eftersom den
är liten och versionshanterad.
"""

import csv
import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else SCRIPT_DIR
BOLAGSVERKET_FILE = DATA_DIR / "bolagsverket_bulkfil.txt"
SCB_FILE = DATA_DIR / "scb_bulkfil.txt"
OUTPUT_FILE = DATA_DIR / "company_registry_cache_import.csv"

# Verifierade encodings. Strict med flit: en tyst teckenförstöring är värre
# än ett stopp, och båda filerna är kontrollerade mot skarp data.
BOLAGSVERKET_ENCODING = "utf-8-sig"
SCB_ENCODING = "latin-1"

# VALFRI. Mappar SNI-koder till officiella etiketter så industry_label får
# samma sorts värde som tier 3 skriver (sni[0].klartext) i stället för
# fritext. Två kolumner: kod, etikett. Utan filen blir industry_label NULL
# och fylls i per bolag av tier 3 senare.
SNI_LOOKUP_FILE = SCRIPT_DIR / "sni_2025_koder.csv"

# ---------------------------------------------------------------------------
# Relevansfilter. Bulkfilen är ett historiskt register, inte en lista över
# företag som finns. Utan filter är ~69 % av raderna bolag man aldrig kan
# sälja sponsring till, och de saknar dessutom SCB-data helt.
#
#   Inget filter                    2 861 310 rader
#   utan avregistrerade             1 127 337 rader
#   utan avregistrerade + ej aktiva   881 696 rader   (2,06 GB -> 681 MB)
# ---------------------------------------------------------------------------
SKIP_DEREGISTERED = True   # avregistreringsdatum ifyllt
SKIP_NOT_ACTIVE = True     # SCB finns och säger FtgStat != 1
SKIP_MISSING_SCB = False   # ingen SCB-rad alls (kan vara nyregistrerat)

# ---------------------------------------------------------------------------
# Kodlistor, enligt SCB:s publicerade variabelbeskrivning.
#
# FtgStat (Företagsstatus) — "verksam" betyder registrerad för moms,
# F-skatt och/eller som arbetsgivare:
#     0 = har aldrig varit verksam   (18,0 % av filen)
#     1 = är verksam                 (75,2 %)
#     9 = ej verksam                 ( 6,8 %)
#
# Reklamsparrtyp — läses tvärtemot vad kolumnen heter, lätt att invertera:
#     1 = har INTE frånsagt sig reklam  -> no_marketing = false  (99,7 %)
#     2 = HAR frånsagt sig reklam       -> no_marketing = true   ( 0,3 %)
# ---------------------------------------------------------------------------
ACTIVE_FTGSTAT_CODES = {"1"}
NO_MARKETING_REKLAMSPARR_CODES = {"2"}

# SCB använder 00000 som platshållare för "okänd näringsgren" (195 528
# rader). Att skriva den som om den vore en riktig SNI-kod är sämre än NULL.
SNI_PLACEHOLDER_CODES = {"00000"}

# Bulkraderna är en baslinje, INTE en hämtning från Bolagsverkets API. Med
# kolumndefaulten now() skulle varje importerat bolag räknas som färskt av
# edge-funktionens FRESHNESS_WINDOW_MS och inte få en live-lookup på 30
# dagar. Bakåtdateringen gör att första lookupen på ett bolag går live.
BULK_LAST_FETCHED_AT = "1970-01-01T00:00:00Z"

# Varje row.get() returnerar None om en kolumn bytt namn, vilket ger en
# lyckad körning med en tyst NULL-kolumn. Headern kontrolleras i stället.
BOLAGSVERKET_REQUIRED = {
    "organisationsidentitet", "namnskyddslopnummer", "registreringsland",
    "organisationsnamn", "organisationsform", "avregistreringsdatum",
    "avregistreringsorsak", "pagandeAvvecklingsEllerOmstruktureringsforfarande",
    "registreringsdatum", "verksamhetsbeskrivning", "postadress",
}
SCB_REQUIRED = {
    "PeOrgNr", "Namn", "FtgStat", "Reklamsparrtyp", "Ng1", "JurForm",
    "COAdress", "Gatuadress", "PostNr", "PostOrt", "JEStat", "RegDatKtid",
}

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
    "is_active",
    "in_liquidation",
    "no_marketing",
    "deregistered_at",
    "deregistration_reason",
    "registered_at",
    "last_fetched_at",
    "raw",
]


# ---------------------------------------------------------------------------
# Delade hjälpare
# ---------------------------------------------------------------------------

def sanitize(value):
    """Postgres kan inte lagra en literal nollbyte i text/jsonb, och vissa
    rader använder strängen "null" som platshållare i stället för att lämna
    fältet tomt — vilket spräcker COPY på typade kolumner.

    Rader med fler fält än headern deklarerar hamnar som en lista under
    None-nyckeln (oescapat citattecken i fritext, 10 rader av 2,97 M), så de
    fogas ihop till en sträng i stället för att krascha.

    Radbrytningar rörs INTE: csv-modulen citerar dem korrekt och Postgres
    COPY ... FORMAT CSV läser flerradiga citerade fält utan problem.
    """
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


ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def safe_date(value, bad):
    """Bolagsverkets fil innehåller enstaka rader med oescapade citattecken.
    csv-modulen tappar då ett fältgränssnitt och hela raden förskjuts, så en
    verksamhetsbeskrivning kan hamna i registreringsdatum-kolumnen.

    Det är någon enstaka rad av knappt tre miljoner, men den typade
    måltabellen accepterar inte texten och COPY avbryter HELA inläsningen —
    en trasig källrad kostar alltså 880 000 bra rader. Datumen är de enda
    kolumnerna som går orörda från fil till typad kolumn, så de kontrolleras
    här. Ser värdet inte ut som ett ISO-datum skrivs NULL i stället, och
    org-numret rapporteras så raden går att titta på i efterhand.
    """
    if not value:
        return None
    if ISO_DATE.match(value):
        return value
    bad.append(value)
    return None


def require_columns(fieldnames, required, filename):
    missing = required - set(fieldnames or ())
    if missing:
        print(f"FEL: {filename} saknar kolumner: {', '.join(sorted(missing))}")
        print(f"     Headern innehåller: {', '.join(fieldnames or ())}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Bolagsverkets fil
# ---------------------------------------------------------------------------

def code_only(value):
    """'S-ORGFO' -> 'S'   'VERKUPP-AVORG' -> 'VERKUPP'"""
    return value.rsplit("-", 1)[0] if value else None


def parse_org_number(value):
    """'8888006577$ORGNR-IDORG' -> '8888006577'"""
    return (value or "").split("$")[0] or None


def parse_name(value):
    """'Acme AB$FORETAGSNAMN-ORGNAM$1993-03-15'
       -> ('Acme AB', 'FORETAGSNAMN', '1993-03-15')"""
    if not value:
        return None, None, None
    parts = value.split("$")
    name = parts[0] or None
    name_type = code_only(parts[1]) if len(parts) > 1 else None
    name_date = parts[2] if len(parts) > 2 and parts[2] else None
    return name, name_type, name_date


def parse_address(value):
    """postadress = gata$c/o$ort$postnr$land

    C/o-ledet hålls separat i stället för att klistras in i gatuadressen —
    'Gimlevägen 34 A$c/o Göran Sandberg$DANDERYD$18253$SE-LAND' ska ge
    address='Gimlevägen 34 A', inte 'Gimlevägen 34 A, c/o Göran Sandberg'.
    """
    if not value:
        return None, None, None, None
    parts = value.split("$")
    if len(parts) < 3:
        return value, None, None, None
    zip_code = parts[-2] or None
    city = parts[-3] or None
    street = parts[0] or None
    co_address = ", ".join(p for p in parts[1:-3] if p) or None
    return street, co_address, city, zip_code


def selection_key(name_type, name_date, namnskydd):
    """Bolag ligger på flera rader — en per registrerat namn, historiskt och
    nuvarande. Föredra nuvarande företagsnamn (FORETAGSNAMN), därefter det
    senast daterade. ISO-datum sorterar rätt som sträng.

    namnskyddslopnummer är sista utslagsgivare: 975 rader har annars exakt
    samma nyckel och avgörs av filordningen. Lägst löpnummer är det primära
    skyddade namnet, så det negeras för att vinna.
    """
    try:
        skydd = -int(namnskydd)
    except (TypeError, ValueError):
        skydd = 0
    return (name_type == "FORETAGSNAMN", name_date or "", skydd)


def scan_bolagsverket():
    """Pass 1: avgör vilken rad som vinner per org-nummer, och samla in de
    andra namnen. Här lagras bara nyckeln — inte hela posten — så minnet
    stannar runt en halv gigabyte i stället för flera."""
    winners = {}
    extra_names = {}
    rows = 0
    skipped = 0
    duplicate_rows = 0

    with open(BOLAGSVERKET_FILE, encoding=BOLAGSVERKET_ENCODING, newline="") as infile:
        reader = csv.DictReader(infile, delimiter=";")
        require_columns(reader.fieldnames, BOLAGSVERKET_REQUIRED, BOLAGSVERKET_FILE.name)

        for row in reader:
            rows += 1
            org_number = parse_org_number(sanitize(row.get("organisationsidentitet")))
            if not org_number:
                skipped += 1
                continue

            name, name_type, name_date = parse_name(sanitize(row.get("organisationsnamn")))
            key = selection_key(name_type, name_date, sanitize(row.get("namnskyddslopnummer")))
            deregistered = bool(sanitize(row.get("avregistreringsdatum")))

            current = winners.get(org_number)
            if current is None:
                winners[org_number] = (key, deregistered, name)
                continue

            duplicate_rows += 1
            # Förlorarradernas namn är inte skräp — de är tidigare och
            # parallella firmanamn, alltså extra sökyta. De sparas i raw.
            names = extra_names.setdefault(org_number, [current[2]])
            if name and name not in names:
                names.append(name)
            if key > current[0]:
                winners[org_number] = (key, deregistered, name)

    print(f"Bolagsverket: {rows} rader, {len(winners)} unika org-nummer")
    if skipped:
        print(f"  hoppade över {skipped} rader utan org-nummer")
    print(f"  {duplicate_rows} extra rader för org-nummer som redan setts")
    print(f"  {len(extra_names)} org-nummer har fler namn (sparas i raw.andra_namn)")

    if SKIP_DEREGISTERED:
        before = len(winners)
        winners = {o: v for o, v in winners.items() if not v[1]}
        print(f"  filtrerar bort {before - len(winners)} avregistrerade "
              f"-> {len(winners)} kvar")

    return winners, extra_names


# ---------------------------------------------------------------------------
# SCB:s fil
# ---------------------------------------------------------------------------

def normalize_pe_org_nr(value):
    """SCB prefixar sitt 12-siffriga PeOrgNr; Bolagsverket gör det inte, så
    värdena måste normaliseras innan de matchar något:

      '16' + 10-siffrigt org-nr  -> skala av till de 10 siffrorna
      '19'/'20' + personnummer   -> behåll alla 12, vilket är exakt så
                                    Bolagsverket skriver dem
                                    ('196406253432$PERSON-IDORG')

    Att joina på råvärdet misslyckas tyst — noll träffar, inget fel — så
    det här är den viktigaste funktionen i SCB-halvan. Allt som inte ser ut
    som något av formaten ovan returneras som None och räknas, i stället
    för att tyst aldrig matcha.
    """
    digits = (value or "").strip()
    if not digits.isdigit() or len(digits) != 12:
        return None
    if digits.startswith("16"):
        return digits[2:]
    if digits[:2] in ("19", "20"):
        return digits
    return None


def scb_flag(value, true_codes):
    """Tomt -> None (NULL, "vi vet inte"), som live-lookupens hantering av
    ett saknat JA/NEJ. Annars true/false enligt kodlistan."""
    if value is None or value == "":
        return None
    return to_pg_bool(value in true_codes)


def load_scb(wanted):
    """Returnerar {org_number: (sni_code, is_active, no_marketing, extras)}.

    `wanted` är org-numren som överlevde Bolagsverket-filtret — allt annat
    slängs direkt i stället för att ligga kvar i minnet. Utan det håller
    dicten 1,8 miljoner poster varav ~665 000 aldrig används.
    """
    by_org = {}
    rows = 0
    unreadable = 0
    unmatched = 0

    with open(SCB_FILE, encoding=SCB_ENCODING, newline="") as infile:
        # QUOTE_NONE är inte valfritt. SCB:s fil har ingen citeringskonvention
        # alls, men csv-modulen antar " som standard — och 702 rader innehåller
        # ett citattecken i fritext. Med standardinställningen sväljer parsern
        # radbrytningar och slår ihop 431 rader till grannraden, tyst.
        reader = csv.DictReader(infile, delimiter="\t", quoting=csv.QUOTE_NONE)
        require_columns(reader.fieldnames, SCB_REQUIRED, SCB_FILE.name)

        for row in reader:
            rows += 1
            row = sanitize_row(row)
            org_number = normalize_pe_org_nr(row.get("PeOrgNr"))
            if not org_number:
                unreadable += 1
                continue
            if org_number not in wanted:
                unmatched += 1
                continue

            sni_code = row.get("Ng1") or None
            if sni_code in SNI_PLACEHOLDER_CODES:
                sni_code = None

            extra_ng = [row.get(f"Ng{i}") for i in range(2, 6)]
            by_org[org_number] = (
                sni_code,
                scb_flag(row.get("FtgStat"), ACTIVE_FTGSTAT_CODES),
                scb_flag(row.get("Reklamsparrtyp"), NO_MARKETING_REKLAMSPARR_CODES),
                {
                    # SCB:s eget namn. "Foretagsnamn" är tomt i 87,9 % av
                    # raderna — det är "Namn" som alltid är ifyllt.
                    "namn": row.get("Namn") or None,
                    "jur_form": row.get("JurForm") or None,  # SCB:s kodlista, INTE Bolagsverkets
                    "je_stat": row.get("JEStat") or None,
                    "reg_datum": row.get("RegDatKtid") or None,
                    "ng_ovriga": [c for c in extra_ng if c] or None,
                    # Bolagsverkets postadress är ofta en box eller c/o.
                    # SCB:s gatuadress är den man faktiskt åker till.
                    "besoksadress": {
                        "gatuadress": row.get("Gatuadress") or None,
                        "postnr": row.get("PostNr") or None,
                        "postort": row.get("PostOrt") or None,
                        "co_adress": row.get("COAdress") or None,
                    },
                },
            )

    print(f"SCB: {rows} rader, {len(by_org)} matchar ett kvarvarande org-nummer")
    if unreadable:
        print(f"  hoppade över {unreadable} rader med oläsbart PeOrgNr")
    print(f"  {unmatched} rader utan motsvarighet i Bolagsverket (kastas)")
    return by_org


# ---------------------------------------------------------------------------
# SNI-etiketter
# ---------------------------------------------------------------------------

def normalize_sni_code(value):
    """SNI-koder skrivs som '64994', '64.994' eller '64.99.4'. Reducera till
    rena siffror så uppslaget matchar oavsett formatering."""
    if not value:
        return None
    digits = "".join(ch for ch in value if ch.isdigit())
    return digits or None


def load_sni_labels():
    """Läser SNI_LOOKUP_FILE till {kod: etikett}. Två kolumner, kod först.
    Returnerar tom dict om filen saknas."""
    if not SNI_LOOKUP_FILE.exists():
        print(f"Ingen SNI-lista på {SNI_LOOKUP_FILE.name} -- industry_label blir NULL")
        return {}

    labels = {}
    with open(SNI_LOOKUP_FILE, encoding="utf-8-sig", newline="") as infile:
        sample = infile.read(4096)
        infile.seek(0)
        delimiter = max([",", ";", "\t"], key=sample.count)

        for row in csv.reader(infile, delimiter=delimiter):
            if len(row) < 2:
                continue
            code = normalize_sni_code(row[0])
            label = row[1].strip()
            # Hoppar över headerraden gratis: dess första cell saknar siffror.
            if code and label:
                labels[code] = label

    print(f"SNI-lista: {len(labels)} koder")
    return labels


# ---------------------------------------------------------------------------
# Pass 2 — skriv ut
# ---------------------------------------------------------------------------

def write_output(winners, extra_names, scb, sni_labels):
    written = 0
    enriched = 0
    labelled = 0
    dropped_inactive = 0
    dropped_no_scb = 0
    malformed = []

    with open(OUTPUT_FILE, "w", encoding="utf-8", newline="") as outfile, \
            open(BOLAGSVERKET_FILE, encoding=BOLAGSVERKET_ENCODING, newline="") as infile:
        writer = csv.writer(outfile)
        writer.writerow(OUTPUT_COLUMNS)

        for row in csv.DictReader(infile, delimiter=";"):
            row = sanitize_row(row)
            org_number = parse_org_number(row.get("organisationsidentitet"))
            if not org_number:
                continue

            winner = winners.get(org_number)
            if winner is None:
                continue

            name, name_type, name_date = parse_name(row.get("organisationsnamn"))
            key = selection_key(name_type, name_date, row.get("namnskyddslopnummer"))
            if key != winner[0]:
                continue
            # Vinnaren är hittad. Ta bort den så en rad med identisk nyckel
            # inte skrivs ut två gånger.
            del winners[org_number]

            sni_code = is_active = no_marketing = None
            scb_extras = None
            match = scb.get(org_number)
            if match is not None:
                sni_code, is_active, no_marketing, scb_extras = match

            if match is None:
                if SKIP_MISSING_SCB:
                    dropped_no_scb += 1
                    continue
            elif SKIP_NOT_ACTIVE and is_active == "false":
                dropped_inactive += 1
                continue

            # Räknas först här — före filtret blir siffran större än antalet
            # skrivna rader, vilket bara ser ut som en bugg i utskriften.
            if match is not None:
                enriched += 1

            industry_label = sni_labels.get(normalize_sni_code(sni_code)) if sni_code else None
            if industry_label:
                labelled += 1

            street, co_address, city, zip_code = parse_address(row.get("postadress"))
            if not street and scb_extras:
                besok = scb_extras["besoksadress"]
                street, city, zip_code = (
                    besok["gatuadress"] or street,
                    besok["postort"] or city,
                    besok["postnr"] or zip_code,
                )

            avveckling = row.get("pagandeAvvecklingsEllerOmstruktureringsforfarande") or None

            raw = {
                "namnskyddslopnummer": row.get("namnskyddslopnummer") or None,
                "registreringsland": row.get("registreringsland") or None,
                "co_adress": co_address,
                # Kollapsas till in_liquidation, men strängen bär både typ
                # och datum ('|LI-AVOMFO$2019-08-27' = likvidation,
                # '|FUOL-AVOMFO$...' = fusion) och är värd att behålla.
                "avvecklingsforfarande": avveckling,
                "andra_namn": [n for n in extra_names.get(org_number, []) if n and n != name] or None,
            }
            if scb_extras:
                raw["scb"] = scb_extras

            writer.writerow([
                org_number,
                name,
                code_only(row.get("organisationsform")),
                sni_code,
                industry_label,
                # Fritext företaget skriver om sig självt. INTE en
                # näringsgrensklassificering — den kommer från SCB:s Ng1.
                row.get("verksamhetsbeskrivning") or None,
                street,
                city,
                zip_code,
                is_active,
                to_pg_bool(avveckling),
                no_marketing,
                safe_date(row.get("avregistreringsdatum"), malformed),
                code_only(row.get("avregistreringsorsak")),
                safe_date(row.get("registreringsdatum"), malformed),
                BULK_LAST_FETCHED_AT,
                json.dumps(raw, ensure_ascii=False),
            ])
            written += 1

    return written, enriched, labelled, dropped_inactive, dropped_no_scb, malformed


def main():
    for path in (BOLAGSVERKET_FILE, SCB_FILE):
        if not path.exists():
            print(f"Hittade inte:\n  {path}")
            print("Kontrollera filnamnet och att filen ligger bredvid skriptet.")
            sys.exit(1)

    winners, extra_names = scan_bolagsverket()
    scb = load_scb(set(winners))
    sni_labels = load_sni_labels()

    written, enriched, labelled, dropped_inactive, dropped_no_scb, malformed = write_output(
        winners, extra_names, scb, sni_labels
    )

    print(f"\nSkrev {written} rader till {OUTPUT_FILE.name}")
    print(f"  {enriched} matchade en SCB-rad")
    print(f"  {labelled} fick en industry_label ur sin SNI-kod")
    if dropped_inactive:
        print(f"  {dropped_inactive} filtrerades bort som ej verksamma (FtgStat 0/9)")
    if dropped_no_scb:
        print(f"  {dropped_no_scb} filtrerades bort för att de saknar SCB-rad")
    if malformed:
        print(f"  {len(malformed)} datumfält var inte ISO-datum och skrevs som NULL")
        print("    (förskjutna källrader — sannolikt oescapat citattecken)")
        for value in malformed[:3]:
            print(f"    {value[:70]!r}")
    if winners:
        print(f"  VARNING: {len(winners)} org-nummer hittade aldrig sin vinnarrad")


if __name__ == "__main__":
    main()
