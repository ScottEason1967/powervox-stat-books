// api/_auth.js
// -----------------------------------------------------------------------------
// Shared gatekeeper. Verifies the caller's Supabase session token and checks
// they hold a live subscription. Everything that costs money or serves value
// runs through this. Uses the service-role key, which stays server-side only.
// -----------------------------------------------------------------------------
const { createClient } = require("@supabase/supabase-js");

let _admin = null;
function admin() {
  if (!_admin) {
    _admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return _admin;
}

function bearer(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h || !/^Bearer\s+/i.test(h)) return "";
  return h.replace(/^Bearer\s+/i, "").trim();
}

// Pre-launch grace: until Supabase is configured, the gate stands open so the
// product keeps working during setup. The moment the env vars exist, it locks.
function notConfigured() {
  return !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// Verify the token only — returns { ok, user } or { ok:false, code, msg }.
async function requireUser(req) {
  if (notConfigured()) return { ok: true, legacy: true, user: null };
  const token = bearer(req);
  if (!token) return { ok: false, code: 401, msg: "Please sign in." };
  try {
    const { data, error } = await admin().auth.getUser(token);
    if (error || !data || !data.user) return { ok: false, code: 401, msg: "Please sign in again." };
    return { ok: true, user: data.user };
  } catch (e) {
    return { ok: false, code: 401, msg: "Please sign in again." };
  }
}

// Verify the token AND require a live subscription.
async function requireSubscriber(req) {
  const u = await requireUser(req);
  if (!u.ok) return u;
  if (u.legacy) return u; // pre-launch: no gate until Supabase is configured
  try {
    const { data } = await admin().from("subscriptions").select("status, quantity, stripe_customer_id, stripe_subscription_id").eq("user_id", u.user.id).maybeSingle();
    const status = (data && data.status) || "none";
    if (status === "active" || status === "trialing") {
      return { ok: true, user: u.user, sub: data };
    }
    return { ok: false, code: 402, msg: "An active subscription is needed for this.", user: u.user, sub: data || null };
  } catch (e) {
    return { ok: false, code: 500, msg: "Could not check the subscription just now." };
  }
}

module.exports = { admin, requireUser, requireSubscriber };
