// api/portal.js
// Opens Stripe's customer portal so subscribers manage cards, invoices and
// cancellation themselves — no support burden on our side.
const { requireUser, admin } = require("./_auth.js");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const u = await requireUser(req);
  if (!u.ok) { res.statusCode = u.code; return res.end(JSON.stringify({ error: u.msg })); }
  try {
    const { data } = await admin().from("subscriptions")
      .select("stripe_customer_id").eq("user_id", u.user.id).maybeSingle();
    if (!data || !data.stripe_customer_id) {
      res.statusCode = 404; return res.end(JSON.stringify({ error: "No billing account yet — subscribe first." }));
    }
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const appUrl = process.env.APP_URL || ("https://" + (req.headers["x-forwarded-host"] || req.headers.host || ""));
    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: appUrl + "/"
    });
    res.statusCode = 200;
    res.end(JSON.stringify({ url: session.url }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Could not open the billing page just now." }));
  }
};
module.exports.default = module.exports;
