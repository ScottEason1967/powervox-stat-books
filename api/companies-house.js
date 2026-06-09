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
// WORKS AS-IS ON: Vercel (put this file at /api/companies-house.js) and Netlify
// (it is picked up as a function). Both run modern Node with a global fetch().
//
// SETUP (one time):
//   1. Get a free Companies House API key:
//      https://developer.company-information.service.gov.uk/  -> register ->
//      create an application -> create a "Live" REST key.
//   2. In the host dashboard, add an environment variable:
//        CH_API_KEY = your_key
//   3. Deploy. The button then works with no further steps for the visitor.
//
// Returns JSON: { company, officers, psc, filings } — the exact shape the page's
// merge logic consumes.
// -----------------------------------------------------------------------------

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
  // cap at a few pages so a very long history can't hang the request
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

// Vercel/Netlify Node function signature: (req, res)
module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300"); // cache 5 min

  const key = process.env.CH_API_KEY;
  if (!key) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "Server is missing the CH_API_KEY environment variable." }));
  }

  // company number from the query string
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

    const payload = {
      company,
      officers: (officers && Array.isArray(officers.items)) ? officers.items : [],
      psc: (psc && Array.isArray(psc.items)) ? psc.items : [],
      filings: Array.isArray(filings) ? filings : []
    };

    res.statusCode = 200;
    return res.end(JSON.stringify(payload));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "Unexpected error contacting Companies House." }));
  }
};

// Allow `export default` style imports too (Vercel ESM / Netlify).
module.exports.default = module.exports;
