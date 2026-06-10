// api/search.js
// -----------------------------------------------------------------------------
// Company-name search for the opening screen. The page calls /api/search?q=NAME
// on its own site; this function holds the API key and queries the Companies
// House search, returning a tidy list of matches for the visitor to pick from.
// Lightweight (no OCR), so it stays fast.
// -----------------------------------------------------------------------------
const BASE = "https://api.company-information.service.gov.uk";

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const key = process.env.CH_API_KEY;
  if (!key) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "Server is missing the CH_API_KEY environment variable." }));
  }

  let q = "";
  try {
    if (req.query && req.query.q) q = String(req.query.q);
    else q = new URL(req.url, "http://localhost").searchParams.get("q") || "";
  } catch (e) { /* ignore */ }
  q = q.trim();

  if (q.length < 2) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ items: [] }));
  }

  try {
    const auth = "Basic " + Buffer.from(key + ":").toString("base64");
    const r = await fetch(BASE + "/search/companies?items_per_page=20&q=" + encodeURIComponent(q), {
      headers: { Authorization: auth }
    });
    if (!r.ok) {
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "Search is unavailable right now." }));
    }
    const j = await r.json();
    const items = (j.items || []).map(it => ({
      number: it.company_number || "",
      title: it.title || "",
      status: it.company_status || "",
      created: it.date_of_creation || "",
      address: it.address_snippet || ""
    })).filter(it => it.number && it.title);

    res.statusCode = 200;
    res.setHeader("Cache-Control", "public, max-age=120");
    return res.end(JSON.stringify({ items }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "Unexpected error searching Companies House." }));
  }
};

module.exports.default = module.exports;
