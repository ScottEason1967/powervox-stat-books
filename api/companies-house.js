// api/companies-house.js
// -----------------------------------------------------------------------------
// Backend endpoint for the one-click "Pull from Companies House" button.
//
// The page (Statutory_Register.html) calls /api/companies-house?number=12345678
// on its OWN site. This function holds the Companies House API key (as a hidden
// environment variable, never sent to the visitor) and does the fetch. Because
// the visitor's browser only ever talks to this site, there is no key exposure
// and no cross-origin (CORS) block.
//
// WORKS AS-IS ON: Vercel (put this file at /api/companies-house.js) and Netlify.
// Needs Node 18+ (global fetch) and the pdf-parse dependency (see package.json).
//
// SETUP (one time):
//   1. Free Companies House API key:
//      https://developer.company-information.service.gov.uk/ -> register ->
//      create application -> create a "Live" REST key.
//   2. Add an environment variable on the host:  CH_API_KEY = your_key
//   3. Deploy.
//
// Returns JSON: { company, officers, psc, filings, members } — the shape the
// page's merge logic consumes. The `members` block is reconstructed from the
// incorporation and confirmation statement DOCUMENTS, which is where Companies
// House keeps shareholders (they are not in the plain JSON feeds). PDF layouts
// vary, so members is a best-effort draft to verify, not a guarantee.
// -----------------------------------------------------------------------------

const pdf = require("pdf-parse/lib/pdf-parse.js"); // bypass package index test harness

const BASE = "https://api.company-information.service.gov.uk";

async function chGet(path, key) {
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");
  const r = await fetch(BASE + path, { headers: { Authorization: auth } });
  if (r.status === 404) return { __status: 404 };
  if (r.status === 401) return { __status: 401 };
  if (!r.ok) return { __status: r.status };
  return r.json();
}

async function fetchAllFilings(number, key) {
  const items = [];
  let start = 0;
  const per = 100;
  for (let page = 0; page < 5; page++) {
    const data = await chGet(`/company/${number}/filing-history?items_per_page=${per}&start_index=${start}`, key);
    if (!data || data.__status || !Array.isArray(data.items)) break;
    items.push(...data.items);
    const total = typeof data.total_count === "number" ? data.total_count : items.length;
    start += per;
    if (start >= total || data.items.length === 0) break;
  }
  return items;
}

// -----------------------------------------------------------------------------
// Document download + text extraction
// -----------------------------------------------------------------------------
// The filing-history item carries links.document_metadata (a full Document API
// URL). Appending /content returns the file. The content endpoint usually 302s
// to a signed S3 URL that must be fetched WITHOUT the auth header.
async function fetchDocumentBuffer(metadataUrl, key) {
  try {
    if (!metadataUrl) return null;
    const auth = "Basic " + Buffer.from(key + ":").toString("base64");
    const contentUrl = metadataUrl.replace(/\/+$/, "") + "/content";
    let r = await fetch(contentUrl, {
      headers: { Authorization: auth, Accept: "application/pdf" },
      redirect: "manual"
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return null;
      r = await fetch(loc); // signed URL: no auth header
    }
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch (e) { return null; }
}
async function fetchDocumentText(metadataUrl, key) {
  const buf = await fetchDocumentBuffer(metadataUrl, key);
  if (!buf) return "";
  try { const d = await pdf(buf); return (d && d.text) ? d.text : ""; } catch (e) { return ""; }
}
// OCR fallback for scanned (image-only) documents — done in-function, with no
// third-party service. Rasterises the PDF (pdf-to-img) and reads each page with
// tesseract.js (pure WASM). Pages are read one at a time and we stop as soon as
// the Initial Shareholdings section is captured, so the work is bounded. If
// anything fails it returns "" and members stay blank for manual entry.
async function ocrDocument(buffer) {
  if (!buffer) return "";
  try {
    const { pdf } = await import("pdf-to-img");
    const { createWorker } = require("tesseract.js");
    const doc = await pdf(buffer, { scale: 2 });
    const worker = await createWorker("eng", 1, { cachePath: "/tmp" });
    let combined = "";
    let n = 0;
    try {
      for await (const img of doc) {
        n++;
        const res = await worker.recognize(img);
        combined += "\n" + ((res && res.data && res.data.text) || "");
        if (/Initial Shareholdings/i.test(combined) && /Number of shares/i.test(combined)) break;
        if (n >= 8) break; // bound the work
      }
    } finally { await worker.terminate(); }
    return combined;
  } catch (e) { return ""; }
}

// -----------------------------------------------------------------------------
// Parsing heuristics  (THE TUNABLE PART)
// -----------------------------------------------------------------------------
// Confirmation statements (and the incorporation document) for non-traded
// companies list each shareholder's name and holding, plus transfers since the
// previous statement. WebFiling text is reasonably consistent; software-filed
// and older scanned documents vary. These heuristics target the common layout
// and are written to be easy to adjust once we see a real document's text.

function normaliseClass(raw) {
  if (!raw) return "";
  let c = raw.trim().replace(/\s+/g, " ");
  c = c.replace(/\b(shares?|share)\b/gi, "").trim();
  if (!/ordinary|preference|deferred|redeemable|[A-Z]\b/i.test(c)) return "";
  // Title-case the class label
  return c.split(" ").map(w => /^[A-Z]$/.test(w) ? w : (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(" ");
}

// Returns [{ name, shares, cls }]
// Tuned to the real Companies House confirmation statement layout as produced by
// pdf-parse, which reads:
//   <count> <CLASS> shares held as at the date of this confirmation statement
//   Name:<NAME>
// We anchor on that holding phrase (not the "Shareholding N:" label), so any
// transfer text wedged before a holding does not break the match.
function parseShareholders(text) {
  if (!text) return [];
  const out = [];
  const t = text.replace(/\r/g, "");
  const re = /([\d,]+)\s+([A-Z][A-Z ]*?)\s+shares\s+held\s+as\s+at\s+the\s+date\s+of\s+this\s+confirmation\s+statement\s*Name:\s*([^\n\r]+)/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const shares = parseInt(m[1].replace(/,/g, ""), 10);
    const cls = normaliseClass(m[2]);
    const name = cleanName(m[3]);
    if (name && shares > 0) out.push({ name, shares, cls });
  }
  return dedupeShareholders(out);
}

function cleanName(s) {
  let n = (s || "").replace(/\s+/g, " ").trim();
  // strip trailing label fragments
  n = n.replace(/\b(shareholding|class|number|nominal|currency|shares?|address)\b.*$/i, "").trim();
  n = n.replace(/[,:;]+$/, "").trim();
  if (n.length < 2 || n.length > 80) return "";
  return n;
}

function dedupeShareholders(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    const k = s.name.replace(/[^a-z]/gi, "").toLowerCase() + "|" + (s.cls || "") + "|" + s.shares;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// Returns [{ name, shares, cls }] from an incorporation document's
// "Initial Shareholdings" blocks. Used for newly formed companies that have not
// yet filed a confirmation statement, so shareholders live only here. Layout:
//   Initial Shareholdings  Name: <NAME>  Address <...>
//   Class of Shares: <CLASS>  Number of shares: <COUNT>
// Tolerant of both clean electronic text and messy OCR output (where the label
// order is jumbled across lines). We split on each "Initial Shareholdings" block
// and pull Name / Class / Number independently within it.
function parseInitialShareholders(text) {
  if (!text) return [];
  const out = [];
  const t = text.replace(/\r/g, "\n");
  const segs = t.split(/Initial Shareholdings/i);
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i].split(/Persons with Significant Control|Statement of (?:Compliance|Initial)|Lawful Purpose|Each subscriber|Electronically filed document for Company/i)[0];
    const nameM = /Name:\s*([^\n]+)/i.exec(seg);
    const numM = /Number of shares?:\s*([\d,]+)/i.exec(seg);
    const classM = /Class of Shares:\s*([A-Za-z][A-Za-z ]*?)\s*(?:\n|$|Number|Currency|Prescribed|Nominal)/i.exec(seg);
    if (nameM && numM) {
      const name = cleanName(nameM[1]);
      const shares = parseInt(numM[1].replace(/,/g, ""), 10);
      const cls = classM ? normaliseClass(classM[1]) : "Ordinary";
      if (name && shares > 0) out.push({ name, shares, cls });
    }
  }
  return dedupeShareholders(out);
}
function titleCaseName(s) { return (s || "").toLowerCase().replace(/\b\w/g, m => m.toUpperCase()); }

// Returns [{ date, detail }]
// Real layout: "<count> transferred on YYYY-MM-DD" (class and parties are not
// given on that line), so we record the count and date only.
function parseTransfers(text) {
  if (!text) return [];
  const out = [];
  const t = text.replace(/\r/g, "");
  const re = /([\d,]+)\s+transferred\s+on\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    const shares = m[1].replace(/,/g, "");
    const date = /^\d{4}-/.test(m[2]) ? chDate(m[2]) : normaliseDate(m[2]);
    out.push({ date: date, detail: shares + " shares transferred" });
  }
  return out;
}

function normaliseDate(s) {
  const m = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/.exec(s || "");
  if (!m) return s;
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  let yr = m[3]; if (yr.length === 2) yr = "20" + yr;
  const mo = parseInt(m[2], 10);
  return parseInt(m[1], 10) + " " + (months[mo - 1] || m[2]) + " " + yr;
}

// Build the members block from documents. Walk confirmation statements newest
// first; use the first one that yields shareholders for the current list.
async function buildMembers(filings, key) {
  const isCS = f => /^CS01$/i.test(f.type || "") || (f.category || "") === "confirmation-statement" ||
                    (f.category || "") === "annual-return" || /^363|^AR01/i.test(f.type || "");
  const isInc = f => /^NEWINC$/i.test(f.type || "") || (f.category || "") === "incorporation";

  const csFilings = filings.filter(isCS)
    .sort((a, b) => String(b.date).localeCompare(String(a.date))); // newest first
  const incFiling = filings.find(isInc);

  let current = [];
  let source = "";
  const docsToScan = csFilings.slice(0, 5);
  if (incFiling) docsToScan.push(incFiling);

  const transfers = [];
  const foundingAllotments = [];
  let rawSample = "";

  for (const f of docsToScan) {
    const metaUrl = f.links && f.links.document_metadata;
    const text = await fetchDocumentText(metaUrl, key);
    if (!text) continue;
    if (!rawSample) rawSample = text.slice(0, 1500);
    parseTransfers(text).forEach(t => transfers.push(t));
    if (current.length === 0) {
      const sh = parseShareholders(text);
      if (sh.length) {
        current = sh;
        source = isInc(f) ? "as at incorporation" : ("per confirmation statement dated " + chDate(f.date));
      } else if (isInc(f)) {
        // Newly formed company with no confirmation statement yet: read the
        // initial shareholdings straight from the incorporation document.
        const init = parseInitialShareholders(text);
        if (init.length) {
          current = init;
          source = "as at incorporation";
          init.forEach(s => foundingAllotments.push({
            date: chDate(f.date),
            details: s.shares + (s.cls ? " " + s.cls : "") + " shares allotted to " + titleCaseName(s.name) + " on incorporation"
          }));
        }
      }
    }
  }

  // OCR fallback: if the text read found no shareholders, the incorporation
  // document is likely a scanned image. OCR it and try the reader again.
  if (!current.length && incFiling) {
    const buf = await fetchDocumentBuffer(incFiling.links && incFiling.links.document_metadata, key);
    const ocrText = await ocrDocument(buf);
    if (ocrText) {
      if (!rawSample) rawSample = ocrText.slice(0, 1500);
      const init = parseInitialShareholders(ocrText);
      if (init.length) {
        current = init;
        source = "as at incorporation";
        init.forEach(s => foundingAllotments.push({
          date: chDate(incFiling.date),
          details: s.shares + (s.cls ? " " + s.cls : "") + " shares allotted to " + titleCaseName(s.name) + " on incorporation"
        }));
      }
    }
  }

  // name, class and share count only — nominal value and address are left blank
  // for the user, to avoid putting guessed figures into a statutory register.
  current = current.map(s => ({ name: s.name, cls: s.cls, shares: s.shares, nominal: "" }));

  return { current, source, transfers, allotments: foundingAllotments, rawSample };
}

function chDate(s) {
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return parseInt(m[3], 10) + " " + months[parseInt(m[2], 10) - 1] + " " + m[1];
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");

  const key = process.env.CH_API_KEY;
  if (!key) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "Server is missing the CH_API_KEY environment variable." }));
  }

  let number = "";
  try {
    if (req.query && req.query.number) number = String(req.query.number);
    else {
      const u = new URL(req.url, "http://localhost");
      number = u.searchParams.get("number") || "";
    }
  } catch (e) { /* ignore */ }
  number = number.trim().toUpperCase().replace(/\s+/g, "");

  if (!/^[A-Z0-9]{6,8}$/.test(number)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "Enter a valid Companies House company number (6 to 8 characters)." }));
  }

  try {
    const company = await chGet(`/company/${number}`, key);
    if (company && company.__status === 401) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "Companies House rejected the API key. Check CH_API_KEY is a Live REST key." }));
    }
    if (!company || company.__status === 404) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "No company found with that number." }));
    }

    const [officers, psc, filings] = await Promise.all([
      chGet(`/company/${number}/officers`, key),
      chGet(`/company/${number}/persons-with-significant-control`, key),
      fetchAllFilings(number, key)
    ]);

    // Reconstruct members from the incorporation + confirmation statement docs.
    // Best-effort; if parsing finds nothing, members is simply empty.
    let members = { current: [], source: "", transfers: [], rawSample: "" };
    try { members = await buildMembers(filings, key); } catch (e) { /* leave empty */ }

    const payload = {
      company,
      officers: (officers && Array.isArray(officers.items)) ? officers.items : [],
      psc: (psc && Array.isArray(psc.items)) ? psc.items : [],
      filings: Array.isArray(filings) ? filings : [],
      members
    };

    res.statusCode = 200;
    return res.end(JSON.stringify(payload));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "Unexpected error contacting Companies House." }));
  }
};

module.exports.default = module.exports;
