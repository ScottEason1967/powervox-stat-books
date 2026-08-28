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
async function ocrDocument(buffer, maxPages, deadline) {
  const pageCap = maxPages || 8;
  const diag = { tried: true, stage: "start", pages: 0 };
  if (!buffer) { diag.stage = "no-buffer"; return { text: "", diag }; }
  try {
    diag.stage = "import-pdf-to-img";
    const { pdf } = await import("pdf-to-img");
    diag.stage = "require-tesseract";
    const { createWorker } = require("tesseract.js");
    diag.stage = "rasterise";
    const doc = await pdf(buffer, { scale: 2 });
    diag.docPages = doc.length;
    diag.stage = "create-worker";
    const worker = await createWorker("eng", 1, { cachePath: "/tmp" });
    let combined = "";
    let n = 0;
    let stopAfter = 0;
    diag.stage = "recognise";
    try {
      for await (const img of doc) {
        n++; diag.pages = n;
        const res = await worker.recognize(img);
        combined += "\n" + ((res && res.data && res.data.text) || "");
        // Once the Initial Shareholdings section is captured, read ONE more page
        // (a long shareholder list can spill over), then stop.
        if (!stopAfter && /Initial Shareholdings?/i.test(combined) && /Number of shares/i.test(combined)) stopAfter = n + 1;
        if (stopAfter && n >= stopAfter) break;
        // Statements: stop once the shareholder list has been read and the closing
        // section starts, so we don't OCR trailing boilerplate pages.
        if (/shares\s+held\s+as\s+at\s+the\s+date\s+of\s+this/i.test(combined) &&
            /Authorisation|End of Electronically Filed Document/i.test(combined)) break;
        if (n >= pageCap) break; // bound the work
        if (deadline && Date.now() > deadline) { diag.stage = "deadline"; break; } // time, not pages, is the real budget
      }
    } finally { await worker.terminate(); }
    diag.stage = "done"; diag.chars = combined.length;
    return { text: combined, diag };
  } catch (e) {
    diag.error = (e && e.message) ? e.message : String(e);
    try { console.error("OCR failed at stage", diag.stage, "-", diag.error); } catch (_) {}
    return { text: "", diag };
  }
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
  // Confirmation statements say "...this confirmation statement"; older annual
  // returns (AR01) say "...this return". Accept both.
  const re = /([\d,]+)\s+([A-Z][A-Z ]*?)\s+shares\s+held\s+as\s+at\s+the\s+date\s+of\s+this\s+(?:confirmation\s+statement|return)\s*Name:\s*([^\n\r]+)/gi;
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
  const segs = t.split(/Initial Shareholdings?/i);
  for (let i = 1; i < segs.length; i++) {
    // Stop at the next section, but NOT at page footers — one header's list can
    // run across a page boundary.
    const seg = segs[i].split(/Persons with Significant Control|Statement of (?:Compliance|Initial)|Lawful Purpose|Each subscriber/i)[0];
    // One "Initial Shareholdings" header can cover SEVERAL shareholders (one
    // Name/Class/Number cluster each). Carve into blocks, one per Name line.
    const blocks = seg.split(/(?=Name\s*:)/i);
    for (const b of blocks) {
      const nameM = /^\s*Name\s*:\s*([^\n]+)/i.exec(b);
      const numM = /Number of shares?\s*:\s*([\d,]+)/i.exec(b);
      const classM = /Class of Shares?\s*:\s*([A-Za-z][A-Za-z ]*?)\s*(?:\n|$|Number|Currency|Prescribed|Nominal)/i.exec(b);
      if (nameM && numM) {
        const name = cleanName(nameM[1]);
        const shares = parseInt(numM[1].replace(/,/g, ""), 10);
        const cls = classM ? normaliseClass(classM[1]) : "Ordinary";
        if (name && shares > 0) out.push({ name, shares, cls });
      }
    }
  }
  return dedupeShareholders(out);
}
function titleCaseName(s) { return (s || "").toLowerCase().replace(/\b\w/g, m => m.toUpperCase()); }

// Reads the issued-share total from a statement's "Statement of Capital".
// Prefers the explicit Totals line; falls back to summing each class's
// "Number allotted". Tolerates pdf-parse jamming label and value together
// ("Number allotted100", "Total number of shares:1").
function parseCapitalTotal(text) {
  if (!text) return null;
  const tot = /Total number of shares:?\s*([\d,]+)/i.exec(text);
  if (tot) return parseInt(tot[1].replace(/,/g, ""), 10);
  let sum = 0, seen = false;
  const re = /Number allotted:?\s*([\d,]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) { sum += parseInt(m[1].replace(/,/g, ""), 10); seen = true; }
  return seen ? sum : null;
}

// Returns rich transfer lines: [{ dateISO, dateDisp, count, cls, from }].
// Each "Shareholding N" block names its holder; a "<count> transferred on
// <date>" line inside the block is shares moving OUT of that holding, so the
// named holder is the TRANSFEROR. The transferee is never stated in the block —
// it is inferred later by comparing against the previous shareholder list.
function parseTransfers(text) {
  if (!text) return [];
  const out = [];
  const t = text.replace(/\r/g, "");
  const blockRe = /Shareholding\s+\d+\s*[:\-]?\s*([^]*?)Name:\s*([^\n]+)/gi;
  let b;
  while ((b = blockRe.exec(t)) !== null) {
    const body = b[1];
    if (body.length > 600) continue; // runaway match, not a real block
    const from = cleanName(b[2]);
    const clsM = /[\d,]+\s+([A-Z][A-Z ]*?)\s+shares\s+held\s+as\s+at/i.exec(body);
    const cls = clsM ? normaliseClass(clsM[1]) : "";
    const lineRe = /([\d,]+)\s+transferred\s+on\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/gi;
    let m;
    while ((m = lineRe.exec(body)) !== null) {
      const count = parseInt(m[1].replace(/,/g, ""), 10);
      const iso = /^\d{4}-/.test(m[2]) ? m[2] : "";
      if (count > 0) out.push({ dateISO: iso, dateDisp: iso ? chDate(iso) : normaliseDate(m[2]), count, cls, from });
    }
  }
  if (!out.length) {
    // Defensive fallback for layouts where the block structure was not matched.
    const re = /([\d,]+)\s+transferred\s+on\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/gi;
    let m;
    while ((m = re.exec(t)) !== null) {
      const count = parseInt(m[1].replace(/,/g, ""), 10);
      const iso = /^\d{4}-/.test(m[2]) ? m[2] : "";
      if (count > 0) out.push({ dateISO: iso, dateDisp: iso ? chDate(iso) : normaliseDate(m[2]), count, cls: "", from: "" });
    }
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
  const t0 = Date.now(); // total time budget guard (Vercel function cap is 60s)
  const isCS = f => /^CS01$/i.test(f.type || "") || (f.category || "") === "confirmation-statement" ||
                    (f.category || "") === "annual-return" || /^363|^AR01/i.test(f.type || "");
  const isInc = f => /^NEWINC$/i.test(f.type || "") || (f.category || "") === "incorporation";
  const isAR = f => (f.category || "") === "annual-return" || /^363|^AR01/i.test(f.type || "");
  const sourceLabel = f =>
    isInc(f) ? "as at incorporation"
    : isAR(f) ? "per annual return dated " + chDate(f.date)
    : "per confirmation statement dated " + chDate(f.date);

  const csFilings = filings.filter(isCS)
    .sort((a, b) => String(b.date).localeCompare(String(a.date))); // newest first
  const incFiling = filings.find(isInc);

  let current = [];
  let source = "";
  // Statements filed as "no updates" never carry a shareholder list, so skip
  // them outright rather than downloading dead weight. Some "with updates"
  // statements still only restate capital, so each survivor is judged on its
  // actual content and we keep walking until one yields shareholders.
  const noUpd = f => /no.?updates|no.?member.?list/i.test(String(f.description || ""));
  // Companies House labels the filings that carry a full shareholder list
  // ("...full-list-shareholders", legacy "full list of members") — trust it.
  const fullList = f => /full.?list/i.test(String(f.description || "") + " " +
    String((f.description_values && f.description_values.description) || ""));
  const informative = csFilings.filter(f => !noUpd(f));
  // Newest 8, PLUS any full-list filings that would otherwise fall off the end.
  const docsToScan = [...new Set([...informative.slice(0, 8), ...informative.filter(fullList).slice(0, 4)])];
  if (incFiling) docsToScan.push(incFiling);

  const transfers = [];       // final register entries [{ date, detail }]
  const transferLines = [];   // rich parsed lines awaiting transferee pairing
  const foundingAllotments = [];
  const scannedDocs = []; // statements with no text layer — OCR candidates
  let rawSample = "";
  let ocrDiag = null;
  let capital = null; // latest issued-share total seen in a statement of capital
  let membersISO = ""; // filing date of the document the members came from
  let lastOcrText = ""; // kept so a fruitless OCR can be inspected in the response

  // Download all candidate documents IN PARALLEL. Fetching them one after
  // another was eating 20-30 seconds of the time budget before OCR could even
  // start, which starved older companies (whose lists live in scanned annual
  // returns) of their OCR window.
  const texts = await Promise.all(
    docsToScan.map(f => fetchDocumentText(f.links && f.links.document_metadata, key))
  );
  for (let di = 0; di < docsToScan.length; di++) {
    const f = docsToScan[di];
    const text = texts[di];
    // Scanned documents are not empty: pdf-parse returns a few stray whitespace
    // characters. Judge by substance, not truthiness, or OCR never triggers.
    const substance = (text || "").replace(/\s+/g, "").length;
    if (substance < 40) { scannedDocs.push(f); continue; }
    if (!rawSample) rawSample = text.slice(0, 1500);
    parseTransfers(text).forEach(t => transferLines.push(t));
    if (!capital && !isInc(f)) {
      const tot = parseCapitalTotal(text);
      if (tot != null) capital = { total: tot, asAt: chDate(f.date), iso: String(f.date || "") }; // newest-first walk: first hit is the latest position
    }
    if (current.length === 0) {
      const sh = parseShareholders(text);
      if (sh.length) {
        current = sh;
        source = sourceLabel(f);
        membersISO = String(f.date || "");
      } else if (isInc(f)) {
        // Newly formed company with no confirmation statement yet: read the
        // initial shareholdings straight from the incorporation document.
        const init = parseInitialShareholders(text);
        if (init.length) {
          current = init;
          source = "as at incorporation";
          membersISO = String(f.date || "");
          init.forEach(s => foundingAllotments.push({
            date: chDate(f.date),
            details: s.shares + (s.cls ? " " + s.cls : "") + " shares allotted to " + titleCaseName(s.name) + " on incorporation"
          }));
        }
      }
    }
    if (current.length) break; // stop at the newest statement that lists shareholders
  }

  // OCR fallback for scanned statements. Many confirmation statements, annual
  // returns and incorporations are filed as scanned images with no text layer, so
  // the shareholder list only becomes readable after OCR. Work through the scanned
  // documents newest first and stop at the first that yields a list. Bounded to a
  // couple of documents to stay within the function time budget. Pre-2009
  // incorporations use an unreadable layout, so they are skipped.
  // The incorporation is the only public document GUARANTEED to name the
  // shareholders, so it gets a protected slot: newest informative scanned
  // statement first (it would carry the CURRENT list if one exists), the
  // incorporation second, any remaining scanned statements after that. It must
  // never sit behind a queue of duds again.
  const scannedCS = scannedDocs.filter(f => !isInc(f));
  const scannedInc = scannedDocs.filter(isInc)
    .filter(f => String(f.date || "") >= "2009-10-01"); // pre-2009 layout is unreadable
  // NEWEST FIRST, strictly. A newer with-updates statement supersedes an older
  // "full list" annual return (WD Close: 2019 statement moved every share to a
  // holding company; the 2015 return's family list is history, not the present).
  // The time gates below are generous enough that a dud first document no
  // longer starves the second — which was the real Teesside problem.
  const ocrQueue = [...scannedCS, ...scannedInc];

  const MAX_OCR = 3;
  let ocrTried = 0;
  for (const f of ocrQueue) {
    if (current.length || ocrTried >= MAX_OCR) break;
    const elapsed = Date.now() - t0;
    if (isInc(f) ? elapsed > 42000 : elapsed > 38000) continue; // stay inside the 60s function cap
    ocrTried++;
    const buf = await fetchDocumentBuffer(f.links && f.links.document_metadata, key);
    const ocr = await ocrDocument(buf, isInc(f) ? 14 : 6, t0 + 50000); // page-level deadline
    ocrDiag = Object.assign({ doc: f.type || f.category || "", bytes: buf ? buf.length : 0 }, ocr.diag);
    const ocrText = ocr.text;
    if (!ocrText) continue;
    lastOcrText = ocrText;
    if (!rawSample) rawSample = ocrText.slice(0, 1500);
    parseTransfers(ocrText).forEach(t => transferLines.push(t));
    if (!capital && !isInc(f)) {
      const tot = parseCapitalTotal(ocrText);
      if (tot != null) capital = { total: tot, asAt: chDate(f.date), iso: String(f.date || "") };
    }
    const sh = parseShareholders(ocrText);
    if (sh.length) {
      current = sh;
      source = sourceLabel(f);
      membersISO = String(f.date || "");
    } else if (isInc(f)) {
      const init = parseInitialShareholders(ocrText);
      if (init.length) {
        current = init;
        source = "as at incorporation";
        membersISO = String(f.date || "");
        init.forEach(s => foundingAllotments.push({
          date: chDate(f.date),
          details: s.shares + (s.cls ? " " + s.cls : "") + " shares allotted to " + titleCaseName(s.name) + " on incorporation"
        }));
      }
    }
  }

  // ---- Build the transfer register: from whom, to whom -----------------------
  // Explicit "transferred on" lines give the transferor (the holder of the block
  // they sit in) and the exact date. The transferee is never stated, and some
  // statements carry no transfer lines at all — both gaps are closed by diffing
  // against the PREVIOUS shareholder list, and pairing only when the arithmetic
  // is unambiguous. Where it isn't, the register says less rather than guessing.
  let previous = [];
  let prevSourceDate = "";
  if (current.length && membersISO) {
    // Free pass: any already-downloaded text document older than the members doc.
    for (let di = 0; di < docsToScan.length; di++) {
      const f = docsToScan[di];
      if (isInc(f) || String(f.date || "") >= membersISO) continue;
      const sh = parseShareholders(texts[di] || "");
      if (sh.length) { previous = sh; prevSourceDate = chDate(f.date); break; }
    }
    // Paid pass (OCR). Worth a slot even when explicit lines exist — the
    // previous list is what names the transferee.
    if (!previous.length && ocrTried < MAX_OCR && Date.now() - t0 < 38000) {
      const prevDoc = scannedCS.find(f => String(f.date || "") < membersISO && fullList(f)) ||
                      scannedCS.find(f => String(f.date || "") < membersISO);
      if (prevDoc) {
        ocrTried++;
        const buf = await fetchDocumentBuffer(prevDoc.links && prevDoc.links.document_metadata, key);
        const ocr = await ocrDocument(buf, 6, t0 + 50000);
        if (ocr.text) {
          const sh = parseShareholders(ocr.text);
          if (sh.length) { previous = sh; prevSourceDate = chDate(prevDoc.date); }
        }
      }
    }
  }
  // Movements between the two lists: who lost shares, who gained.
  const nkey = s => String(s.name || s).replace(/[^a-z0-9]/gi, "").toLowerCase();
  const ins = [], outs = [];
  if (previous.length) {
    const curMap = new Map(current.map(s => [nkey(s), s]));
    const prevMap = new Map(previous.map(s => [nkey(s), s]));
    previous.forEach(p => {
      const c = curMap.get(nkey(p));
      if (!c) outs.push({ name: p.name, count: p.shares, cls: p.cls });
      else if (c.shares < p.shares) outs.push({ name: p.name, count: p.shares - c.shares, cls: p.cls });
    });
    current.forEach(c => {
      const p = prevMap.get(nkey(c));
      if (!p) ins.push({ name: c.name, count: c.shares, cls: c.cls });
      else if (c.shares > p.shares) ins.push({ name: c.name, count: c.shares - p.shares, cls: c.cls });
    });
  }
  const sumOf = a => a.reduce((x, y) => x + y.count, 0);
  const balanced = ins.length > 0 && outs.length > 0 && sumOf(ins) === sumOf(outs);

  if (transferLines.length) {
    // Pair each explicit line with a recipient. Three rules, in order of
    // strength: (1) everything sums to a single gainer — all lines go there;
    // (2) a line's count uniquely matches one gainer's remaining gain — pair
    // and CONSUME it so it cannot be matched twice; (3) otherwise say less.
    const linesTotal = transferLines.reduce((a, l) => a + l.count, 0);
    const insPool = ins.map(i => ({ name: i.name, cls: i.cls, left: i.count }));
    const singleTarget = (insPool.length === 1 && insPool[0].left === linesTotal) ? insPool[0].name : "";
    transferLines.forEach(L => {
      let to = singleTarget;
      if (!to) {
        const m = insPool.filter(i => i.left === L.count && (!L.cls || !i.cls || i.cls === L.cls));
        if (m.length === 1) { to = m[0].name; m[0].left -= L.count; }
      }
      let d = L.count + (L.cls ? " " + L.cls : "") + " shares transferred";
      if (L.from) d += " from " + titleCaseName(L.from);
      if (to) d += " to " + titleCaseName(to);
      else d += " (transferee not identifiable from the public record)";
      transfers.push({ date: L.dateDisp, detail: d });
    });
  } else if (ins.length || outs.length) {
    const asAt = chDate(membersISO);
    const bracket = " (change occurred between " + prevSourceDate + " and " + asAt + "; exact date not on the public record)";
    if (balanced && ins.length === 1) {
      outs.forEach(o => transfers.push({ date: asAt, detail: o.count + (o.cls ? " " + o.cls : "") + " shares transferred from " + titleCaseName(o.name) + " to " + titleCaseName(ins[0].name) + bracket }));
    } else if (balanced && outs.length === 1) {
      ins.forEach(i => transfers.push({ date: asAt, detail: i.count + (i.cls ? " " + i.cls : "") + " shares transferred from " + titleCaseName(outs[0].name) + " to " + titleCaseName(i.name) + bracket }));
    } else {
      outs.forEach(o => transfers.push({ date: asAt, detail: titleCaseName(o.name) + " ceased to hold " + o.count + (o.cls ? " " + o.cls : "") + " shares" + bracket }));
      ins.forEach(i => transfers.push({ date: asAt, detail: titleCaseName(i.name) + " acquired " + i.count + (i.cls ? " " + i.cls : "") + " shares" + bracket }));
    }
  }

  // If OCR ran but yielded no members, surface what it actually read — that is
  // the diagnostic that matters, not the first text document's boilerplate.
  if (!current.length && lastOcrText) rawSample = lastOcrText.slice(0, 2000);

  // A capital total OLDER than the document the members came from is stale and
  // would raise a false alarm — suppress it. (Capital newer than the members is
  // exactly the discrepancy worth flagging, so that survives.)
  if (capital && membersISO && capital.iso && capital.iso < membersISO) capital = null;

  // name, class and share count only — nominal value and address are left blank
  // for the user, to avoid putting guessed figures into a statutory register.
  current = current.map(s => ({ name: s.name, cls: s.cls, shares: s.shares, nominal: "" }));

  // Exact duplicates (same event parsed from more than one document) collapse.
  const seenT = new Set();
  const uniqueTransfers = transfers.filter(t => {
    const k = t.date + "|" + t.detail;
    if (seenT.has(k)) return false;
    seenT.add(k);
    return true;
  });

  return { current, source, transfers: uniqueTransfers, allotments: foundingAllotments, rawSample, ocrDiag, capital };
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
  res.setHeader("Cache-Control", "no-store"); // always live: stale cached pulls caused false "not working" results

  // Paid gate: pulls and updates are the service the subscription buys.
  const { requireSubscriber } = require("./_auth.js");
  const gate = await requireSubscriber(req);
  if (!gate.ok) {
    res.statusCode = gate.code;
    return res.end(JSON.stringify({ error: gate.msg, gate: gate.code === 402 ? "subscribe" : "signin" }));
  }

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
