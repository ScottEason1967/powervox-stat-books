// api/stripe-webhook.js
// Stripe tells us here when money moves: checkout completes, a subscription
// renews, changes quantity, falls into arrears or is cancelled. This is the
// ONLY writer of subscription state — the app just reads it. The signature
// check means nobody but Stripe can talk to this endpoint.
const { admin } = require("./_auth.js");

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

async function upsertFromSubscription(sub, userId) {
  const row = {
    stripe_customer_id: sub.customer,
    stripe_subscription_id: sub.id,
    status: sub.status,
    quantity: (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].quantity) || 1,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    updated_at: new Date().toISOString()
  };
  if (userId) {
    row.user_id = userId;
    await admin().from("subscriptions").upsert(row, { onConflict: "user_id" });
    return;
  }
  // No user id on the event — find the row by customer id.
  const { data } = await admin().from("subscriptions")
    .select("user_id").eq("stripe_customer_id", sub.customer).maybeSingle();
  if (data && data.user_id) {
    row.user_id = data.user_id;
    await admin().from("subscriptions").upsert(row, { onConflict: "user_id" });
  }
}

module.exports = async function handler(req, res) {
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    const raw = await rawBody(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    res.statusCode = 400;
    return res.end("Signature verification failed");
  }
  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.client_reference_id ||
        (session.subscription_data && session.subscription_data.metadata && session.subscription_data.metadata.supabase_user_id) || null;
      if (session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        await upsertFromSubscription(sub, userId);
      }
    } else if (event.type === "customer.subscription.updated" ||
               event.type === "customer.subscription.deleted" ||
               event.type === "customer.subscription.created") {
      const sub = event.data.object;
      const userId = (sub.metadata && sub.metadata.supabase_user_id) || null;
      await upsertFromSubscription(sub, userId);
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ received: true }));
  } catch (e) {
    // Return 500 so Stripe retries — their retry schedule is our safety net.
    res.statusCode = 500;
    res.end("Handler error");
  }
};
module.exports.config = { api: { bodyParser: false } };
module.exports.default = module.exports;
