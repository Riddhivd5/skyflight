// SkyFlight proxy: a free Cloudflare Worker that fetches flight data for the app.
// Needed because the free ADS-B APIs don't allow direct requests from web pages (CORS).
//
// Deploy (works from a phone browser):
//   1. dash.cloudflare.com → sign up / log in (free plan is plenty)
//   2. Workers & Pages → Create → Create Worker → name it e.g. "skyflight" → Deploy
//   3. Edit code → delete everything → paste this whole file → Deploy
//   4. Copy the worker URL, e.g. https://skyflight.<you>.workers.dev
//   5. In SkyFlight: ⚙︎ → Proxy URL → paste it (the app adds the rest)
//
// Endpoints:
//   GET  /?lat=12.97&lon=77.59&dist=40   aircraft near a point (dist in NM, max 250)
//   POST /route                           route lookup (forwarded to adsb.lol routeset)

const UPSTREAMS = [
  (la, lo, r) => `https://api.airplanes.live/v2/point/${la}/${lo}/${r}`,
  (la, lo, r) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${r}`,
  (la, lo, r) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${r}`,
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const UA = { "User-Agent": "SkyFlight/1.0 (personal AR plane spotter)" };
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url);

    // Route lookup
    if (u.pathname === "/route" && request.method === "POST") {
      try {
        const body = await request.text();
        if (body.length > 5000) return json({ error: "too large" }, 413);
        const r = await fetch("https://api.adsb.lol/api/0/routeset", {
          method: "POST", headers: { ...UA, "Content-Type": "application/json" }, body,
        });
        return new Response(r.body, { status: r.status, headers: { ...CORS, "Content-Type": "application/json" } });
      } catch (e) {
        return json({ error: "route service unreachable" }, 502);
      }
    }

    // Aircraft near a point
    if (!u.searchParams.has("lat") || !u.searchParams.has("lon")) return json({ ok: true, usage: "GET /?lat=12.97&lon=77.59&dist=40" });
    const lat = Number(u.searchParams.get("lat"));
    const lon = Number(u.searchParams.get("lon"));
    const dist = Math.min(250, Math.max(1, Number(u.searchParams.get("dist")) || 40));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return json({ error: "bad lat/lon" }, 400);
    }
    let lastErr = "";
    for (const build of UPSTREAMS) {
      try {
        const r = await fetch(build(lat.toFixed(4), lon.toFixed(4), Math.round(dist)), { headers: UA, cf: { cacheTtl: 3 } });
        if (r.ok) return new Response(r.body, { headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "max-age=3" } });
        lastErr = "HTTP " + r.status;
      } catch (e) { lastErr = String(e); }
    }
    return json({ error: "all upstreams failed", detail: lastErr }, 502);
  },
};
