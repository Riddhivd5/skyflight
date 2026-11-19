// SkyFlight proxy: a free Cloudflare Worker that fetches flight data for the app.
// Needed because the free ADS-B APIs don't allow direct requests from web pages (CORS).
//
// Deployed from the GitHub repo together with wrangler.jsonc: Cloudflare then serves
// index.html as the app AND runs this file for the API paths below (same origin, no setup).
// Also works pasted on its own into a Cloudflare Worker (then use it as the Proxy URL).
//
// Endpoints:
//   GET  /api/aircraft?lat=12.97&lon=77.59&dist=40   aircraft near a point (dist in NM, max 250)
//   POST /api/route                                  route lookup (forwarded to adsb.lol routeset)
//   GET  /?lat=..&lon=..&dist=..                     same as /api/aircraft (stand-alone worker)

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
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url);
    const isAircraft = u.pathname === "/api/aircraft" || (u.pathname === "/" && u.searchParams.has("lat"));
    const isRoute = (u.pathname === "/api/route" || u.pathname === "/route") && request.method === "POST";
    if (!isAircraft && !isRoute) {
      if (env && env.ASSETS) return env.ASSETS.fetch(request); // the app itself
      return json({ ok: true, usage: "GET /api/aircraft?lat=12.97&lon=77.59&dist=40" });
    }

    // Route lookup
    if (isRoute) {
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
    if (!u.searchParams.has("lat") || !u.searchParams.has("lon")) return json({ error: "lat and lon required" }, 400);
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
