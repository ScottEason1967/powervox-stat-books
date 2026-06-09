# PowerVox Statutory Register

A statutory register that is both an editor and an issuable document. Hosted on the PowerVox site, a visitor lands on a blank register, enters their company number, clicks **Pull from Companies House**, and the public record fills itself in. They edit anything that needs it, then download a clean, standalone HTML register they can keep, re-edit and print to PDF. No installation, no scripts, no pasting.

## Files

- **`Statutory_Register.html`** — the product. Editor plus register in one file, PowerVox-branded. Served at the site root.
- **`api/companies-house.js`** — the backend endpoint that does the one-click pull (holds the API key, talks to Companies House).
- **`vercel.json`** — serves the register at `/` and sets caching.
- **`package.json`** — declares Node 18+ and the pdf-parse dependency used to read shareholders from filed documents.
- **`.gitignore`** — keeps secrets and local files out of the repo.
- **`companies-house-fetch.py`** — offline fallback only. A script for pulling the data when the file is opened from disk rather than hosted. Most users never touch this.
- **`README.md`** — this file.

## How the Companies House pull works

The page calls `/api/companies-house?number=...` on its **own** site. That backend function holds the Companies House API key (kept as a hidden setting on the host, never sent to the visitor) and makes the request to Companies House. The visitor's browser only ever talks to the PowerVox site, so there is nothing for them to configure, the key is never exposed, and there is no browser security block. They click the button and it fills in.

What the pull fills automatically: company information, current and past directors with appointment and resignation history, current and past PSCs with nature-of-control wording, share events from SH01/SH02-type filings, the next accounts and confirmation statement due dates, and the register of members (shareholder names, share counts and classes) reconstructed from the incorporation and confirmation statement documents. What it leaves for the user: member addresses and nominal values (not on the public record), share certificate numbers, internal consideration figures, the exact within-year dates of transfers, and board minute references.

A note on the members reconstruction. Shareholders are not in the plain data feeds; they live inside the filed documents. The backend downloads the incorporation and confirmation statement PDFs and reads the shareholders out of them. It targets the common WebFiling layout and only fills members when it can read them confidently, so a wrong figure never lands in the register. If a particular company's statements are in an unusual or scanned format, members may come back empty and the import summary says so, leaving you to add them by hand. The parser is written to be tuned: it can be extended once we see the text of a statement it doesn't yet read. This step runs only in the hosted backend; the offline `companies-house-fetch.py` does not reconstruct members.

The merge is non-destructive. It never overwrites a value the user has edited; if their record and Companies House disagree, it keeps theirs and reports the difference. Running a pull twice does not create duplicates.

## Deploy: GitHub repo to Vercel

This is the route we agreed: code lives on GitHub, hosting is on Vercel connected to that repo. You get the static page and the function from the same place, the key stays as a hidden setting, and there is no cross-origin issue because page and function share one site.

1. Put this folder in a GitHub repository (these files at the repo root, with `api/companies-house.js` inside an `api` folder).
2. Get a free Companies House API key (instant):
   `https://developer.company-information.service.gov.uk/` → register → create an application → create a **Live** REST key.
3. In Vercel, "Add New Project" and import the GitHub repo. Vercel detects the static page and the `/api` function automatically.
4. In the Vercel project settings, add an environment variable:
   `CH_API_KEY = your_key`
5. Deploy. Every push to GitHub redeploys automatically. The button then works for every visitor with no further steps.

Netlify works the same way (import the repo, set the same environment variable). If the page is ever served from a sub-path rather than the site root, change `CONFIG.chEndpoint` near the top of the script in `Statutory_Register.html` to match.

After the first deploy, the honest final test is to pull one real company and confirm the register fills correctly.

## Using the register

- **Edit / View** — switch between the form editor and the formatted register.
- **Pull from Companies House** — the one-click pre-fill described above.
- **Export register** — download a clean, read-only standalone HTML file with no editor controls. This is the version a user issues, opens, and prints to PDF (Ctrl/Cmd+P → A4 → Save as PDF). The downloaded file still carries its own data and can be re-opened and edited.
- **Save data / Load data** — download or reload entries as a `.json` file, for backups or moving a company between machines.
- **Load sample / Blank template** — load the worked Eason Law example, or clear to a blank template.

The seven sections follow the Companies Act 2006: company information, directors (s.162), members (s.113), allotments and transfers, PSC register (s.790M), share certificates index, and filings outstanding at Companies House.

A note on saving: in-page autosave is tied to one browser on one machine, so the **Save data** JSON (or the exported register) is the real record, not local storage.

## Offline fallback (rarely needed)

If someone has the HTML file on disk with no backend behind it, the automatic pull cannot reach a server. In that case they run:
```
python companies-house-fetch.py 12308593 --key YOUR_API_KEY -o company.json
```
and paste the output into the import dialog's offline box. For the hosted PowerVox product this path is not part of the normal flow.

## Branding

Skinned to the PowerVox brand: Forest Green (`#2D5F3F`) as the primary, Mulberry (`#7B3F61`) as a sparing accent, Warm Earth (`#5C4A3A`) body text on Warm Linen (`#F5F0EB`), with Soft Sage (`#D4DDD2`) highlights and Warm Stone rules. Type is Inter, a clean humanist sans, in line with the brand guide (no serif, no all-caps, no drop shadows, no boxed banners). The wordmark is the "PowerVox" text mark in Forest Green, as the brand guide specifies; there is no logo lockup yet. To adjust, edit the `:root` block (colours) and the `CONFIG` object (wordmark, logo) near the top of the file. Inter loads from Google Fonts when online and falls back to the system sans offline.

## What this is and isn't

This is the hosted single-company product: blank page, one-click pre-fill, edit, download. It is not the multi-company practice tool (no dashboard across companies, no scheduled re-polling for new filings, no audit trail of changes). Those are a separate roadmap decision.
