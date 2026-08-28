// api/registers.js
// Server-side storage of each customer's statutory books, and the enforcement
// of per-company pricing: the Stripe subscription quantity always equals the
// number of companies held. All access is authenticated; a live subscription
// is needed to create or update. Reads stay available to lapsed accounts so
// nobody is ever locked away from their own registers.
const { requireUser, requireSubscriber, admin } = require("./_auth.js");

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { return {}; }
}

async function syncQuantity(userId) {
  try {
    const { count } = await admin().from("registers")
      .select("company_number", { count: "exact", head: true }).eq("user_id", userId);
    const { data: sub } = await admin().from("subscriptions")
      .select("stripe_subscription_id").eq("user_id", userId).maybeSingle();
    if (!sub || !sub.stripe_subscription_id) return;
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const s = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    const item = s.items && s.items.data && s.items.data[0];
    const want = Math.max(1, count || 0); // a subscription never drops below one seat
    if (item && item.quantity !== want) {
      await stripe.subscriptionItems.update(item.id, { quantity: want, proration_behavior: "create_prorations" });
    }
  } catch (e) { /* quantity sync is best-effort; the webhook keeps us honest */ }
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const method = (req.method || "GET").toUpperCase();

  // Reading your own books needs sign-in only — lapsed subscribers keep access.
  if (method === "GET") {
    const u = await requireUser(req);
    if (!u.ok) { res.statusCode = u.code; return res.end(JSON.stringify({ error: u.msg })); }
    if (u.legacy) { res.statusCode = 200; return res.end(JSON.stringify({ items: [], legacy: true })); }
    const url = new URL(req.url, "http://x");
    const number = (url.searchParams.get("number") || "").trim().toUpperCase();
    if (number) {
      const { data } = await admin().from("registers")
        .select("company_number, company_name, data, updated_at")
        .eq("user_id", u.user.id).eq("company_number", number).maybeSingle();
      if (!data) { res.statusCode = 404; return res.end(JSON.stringify({ error: "Not found." })); }
      res.statusCode = 200; return res.end(JSON.stringify(data));
    }
    const { data } = await admin().from("registers")
      .select("company_number, company_name, updated_at")
      .eq("user_id", u.user.id).order("updated_at", { ascending: false });
    res.statusCode = 200; return res.end(JSON.stringify({ items: data || [] }));
  }

  // Creating and updating needs a live subscription.
  const g = await requireSubscriber(req);
  if (!g.ok) { res.statusCode = g.code; return res.end(JSON.stringify({ error: g.msg })); }
  if (g.legacy) { res.statusCode = 200; return res.end(JSON.stringify({ saved: false, legacy: true })); }
  const body = await readJson(req);
  const number = String(body.number || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6,8}$/.test(number)) {
    res.statusCode = 400; return res.end(JSON.stringify({ error: "A valid company number is needed." }));
  }

  if (method === "POST" || method === "PUT") {
    const row = {
      user_id: g.user.id,
      company_number: number,
      company_name: String(body.name || "").slice(0, 200),
      data: body.data || {},
      updated_at: new Date().toISOString()
    };
    const isNew = method === "POST";
    if (isNew) {
      const { count } = await admin().from("registers")
        .select("company_number", { count: "exact", head: true }).eq("user_id", g.user.id);
      const { error } = await admin().from("registers").upsert(row, { onConflict: "user_id,company_number" });
      if (error) { res.statusCode = 500; return res.end(JSON.stringify({ error: "Could not save the register." })); }
      // Additional companies raise the subscription quantity (pro-rated by Stripe).
      if ((count || 0) >= 1) await syncQuantity(g.user.id);
      res.statusCode = 200; return res.end(JSON.stringify({ saved: true }));
    }
    const { error } = await admin().from("registers").upsert(row, { onConflict: "user_id,company_number" });
    if (error) { res.statusCode = 500; return res.end(JSON.stringify({ error: "Could not save the register." })); }
    res.statusCode = 200; return res.end(JSON.stringify({ saved: true }));
  }

  if (method === "DELETE") {
    await admin().from("registers").delete().eq("user_id", g.user.id).eq("company_number", number);
    await syncQuantity(g.user.id);
    res.statusCode = 200; return res.end(JSON.stringify({ deleted: true }));
  }

  res.statusCode = 405;
  res.end(JSON.stringify({ error: "Method not allowed." }));
};
module.exports.default = module.exports;
