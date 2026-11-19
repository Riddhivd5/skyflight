// Optional CORS proxy for SkyLens, as a Cloudflare Worker (free tier is plenty).
// Use it only if the free ADS-B APIs refuse requests from your browser.
//
// Deploy: dash.cloudflare.com → Workers & Pages → Create → "Hello World" worker →
// replace the code with this file → Deploy. Then in SkyLens ⚙︎ set:
//   Data source: "My own proxy"
//   Proxy URL:   https://<your-worker>.workers.dev/?lat={lat}&lon={lon}&dist={dist}

const UPSTREAMS = [
  (la, lo, r) => `https://api.airplanes.live/v2/point/${la}/${lo}/${r}`,
  (la, lo, r) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${r}`,
  (la, lo, r) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${r}`,
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url);
    const lat = Number(u.searchParams.get("lat"));
    const lon = Number(u.searchParams.get("lon"));
    const dist = Math.min(250, Math.max(1, Number(u.searchParams.get("dist")) || 40));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return new Response(JSON.stringify({ error: "bad lat/lon" }), { status: 400, headers: CORS });
    }
    for (const build of UPSTREAMS) {
      try {
        const r = await fetch(build(lat.toFixed(4), lon.toFixed(4), Math.round(dist)), {
          headers: { "User-Agent": "SkyLens/1.0 (personal AR plane spotter)" },
          cf: { cacheTtl: 3 },
        });
        if (r.ok) return new Response(r.body, { headers: { ...CORS, "Cache-Control": "max-age=3" } });
      } catch (e) { /* try next */ }
    }
    return new Response(JSON.stringify({ error: "all upstreams failed" }), { status: 502, headers: CORS });
  },
};
