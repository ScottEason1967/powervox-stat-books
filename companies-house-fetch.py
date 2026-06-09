#!/usr/bin/env python3
"""
companies-house-fetch.py
------------------------
Pulls a UK company's public record from the Companies House Public Data API
and writes a single JSON file that the Statutory Register editor imports
(Import from Companies House > paste the JSON).

Why a script and not a button in the page:
The Companies House API needs an API key sent as HTTP Basic auth and does not
return CORS headers, so a browser cannot call it from a file:// page, and
shipping a key inside an HTML file would be poor practice. Running the fetch
here keeps the key on your machine and avoids the browser restriction entirely.

Get a free API key (instant):
  https://developer.company-information.service.gov.uk/  > register > create
  an application > "Live" REST key.

Usage:
  python companies-house-fetch.py 12308593 --key YOUR_API_KEY
  python companies-house-fetch.py 12308593 --key YOUR_API_KEY -o eason.json

Then open the register, click "Import from Companies House", and paste the
contents of the written file.

No third-party packages required (uses the standard library only).
"""

import argparse
import base64
import json
import sys
import urllib.request
import urllib.error

BASE = "https://api.company-information.service.gov.uk"


def get(path, key):
    """GET a CH API path and return parsed JSON (or None on 404)."""
    url = BASE + path
    req = urllib.request.Request(url)
    token = base64.b64encode((key + ":").encode("utf-8")).decode("ascii")
    req.add_header("Authorization", "Basic " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        if e.code == 401:
            sys.exit("ERROR: 401 Unauthorised. Check your API key (and that it is a 'Live' REST key).")
        if e.code == 429:
            sys.exit("ERROR: 429 rate limited by Companies House. Wait a minute and try again.")
        raise


def fetch_all_filings(number, key):
    """Page through the full filing history."""
    items = []
    start = 0
    per_page = 100
    while True:
        data = get(f"/company/{number}/filing-history?items_per_page={per_page}&start_index={start}", key)
        if not data:
            break
        page = data.get("items", [])
        items.extend(page)
        total = data.get("total_count", len(items))
        start += per_page
        if start >= total or not page:
            break
    return items


def main():
    ap = argparse.ArgumentParser(description="Fetch a UK company's public record from Companies House.")
    ap.add_argument("number", help="Company number, e.g. 12308593")
    ap.add_argument("--key", required=True, help="Your Companies House API key")
    ap.add_argument("-o", "--out", help="Output JSON file (default: <number>_companies_house.json)")
    args = ap.parse_args()

    number = args.number.strip()
    out = args.out or f"{number}_companies_house.json"

    print(f"Fetching company {number} from Companies House...")
    company = get(f"/company/{number}", args.key)
    if not company:
        sys.exit(f"ERROR: company {number} not found.")

    officers_resp = get(f"/company/{number}/officers", args.key) or {}
    psc_resp = get(f"/company/{number}/persons-with-significant-control", args.key) or {}
    filings = fetch_all_filings(number, args.key)

    payload = {
        "company": company,
        "officers": officers_resp.get("items", []),
        "psc": psc_resp.get("items", []),
        "filings": filings,
    }

    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    print(f"  company name        : {company.get('company_name')}")
    print(f"  officers returned   : {len(payload['officers'])}")
    print(f"  PSCs returned       : {len(payload['psc'])}")
    print(f"  filings returned    : {len(payload['filings'])}")
    print(f"\nWritten: {out}")
    print("Open the register, click 'Import from Companies House', and paste this file's contents.")


if __name__ == "__main__":
    main()
