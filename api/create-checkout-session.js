// api/create-checkout-session.js
// Starts a Stripe Checkout for the monthly subscription. The customer pays on
// Stripe's own hosted page — card details never touch our site.
const { requireUser, admin } = require("./_auth.js");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const u = await requireUser(req);
  if (!u.ok) { res.statusCode = u.code; return res.end(JSON.stringify({ error: u.msg })); }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
    res.statusCode = 500; return res.end(JSON.stringify({ error: "Payments are not configured yet." }));
  }
  try {
    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    const appUrl = process.env.APP_URL || ("https://" + (req.headers["x-forwarded-host"] || req.headers.host || ""));

    // Reuse the Stripe customer if this account has been through checkout before.
    const { data: existing } = await admin().from("subscriptions")
      .select("stripe_customer_id, status").eq("user_id", u.user.id).maybeSingle();
    if (existing && (existing.status === "active" || existing.status === "trialing")) {
      res.statusCode = 200;
      return res.end(JSON.stringify({ already: true }));
    }

    const params = {
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: u.user.id,
      success_url: appUrl + "/?checkout=success",
      cancel_url: appUrl + "/?checkout=cancelled",
      allow_promotion_codes: true,
      subscription_data: { metadata: { supabase_user_id: u.user.id } }
    };
    if (existing && existing.stripe_customer_id) params.customer = existing.stripe_customer_id;
    else params.customer_email = u.user.email;

    const session = await stripe.checkout.sessions.create(params);
    res.statusCode = 200;
    res.end(JSON.stringify({ url: session.url }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Could not start the payment page just now." }));
  }
};
module.exports.default = module.exports;
