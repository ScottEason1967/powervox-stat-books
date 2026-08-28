// api/config.js
// Public client configuration. The anon key is designed to be public — all
// real protection is server-side (the service key and row security).
module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.statusCode = 200;
  res.end(JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ""
  }));
};
module.exports.default = module.exports;
