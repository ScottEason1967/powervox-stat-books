// api/me.js
// Who am I, and where does my subscription stand? Drives the app's states:
// signed out → sign-in panel; signed in without subscription → subscribe panel;
// subscriber → the product.
const { requireUser, admin } = require("./_auth.js");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const u = await requireUser(req);
  if (!u.ok) { res.statusCode = u.code; return res.end(JSON.stringify({ error: u.msg })); }
  if (u.legacy) { res.statusCode = 200; return res.end(JSON.stringify({ status: "legacy" })); }
  try {
    const { data } = await admin().from("subscriptions")
      .select("status, quantity, current_period_end")
      .eq("user_id", u.user.id).maybeSingle();
    res.statusCode = 200;
    res.end(JSON.stringify({
      email: u.user.email,
      status: (data && data.status) || "none",
      quantity: (data && data.quantity) || 0,
      currentPeriodEnd: (data && data.current_period_end) || null
    }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Could not load your account just now." }));
  }
};
module.exports.default = module.exports;
