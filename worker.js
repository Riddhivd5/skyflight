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
//   GET  /api/callsign/IGO6123                       origin/destination airports (adsbdb, free)
//   GET  /api/flight?ident=IGO6123                   scheduled/actual times (FlightAware AeroAPI)
//
// Schedule times need a FlightAware AeroAPI key (Personal tier has a free monthly allowance):
//   Cloudflare dashboard → Workers & Pages → skyflight → Settings → Variables and Secrets
//   → Add → Type: Secret, Name: AEROAPI_KEY, Value: <your key> → Deploy
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
    if (u.pathname.startsWith("/api/callsign/")) return callsign(u.pathname.slice(14));
    if (u.pathname === "/api/flight") return flight(u.searchParams.get("ident") || "", env);
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

// ---------- airports for a callsign (adsbdb) ----------
async function callsign(cs) {
  cs = cs.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  if (!cs) return json({ error: "callsign required" }, 400);
  try {
    const r = await fetch("https://api.adsbdb.com/v0/callsign/" + cs, { headers: UA, cf: { cacheTtl: 86400 } });
    return new Response(r.body, { status: r.status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "max-age=3600" } });
  } catch (e) { return json({ error: "adsbdb unreachable" }, 502); }
}

// ---------- schedule / actual times (FlightAware AeroAPI) ----------
async function flight(ident, env) {
  ident = ident.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  if (!ident) return json({ error: "ident required" }, 400);
  if (!env || !env.AEROAPI_KEY) return json({ error: "no_key" }, 501);
  const cache = caches.default, key = new Request("https://cache.skyflight.internal/flight/" + ident);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { ...CORS, "Content-Type": "application/json" } });
  let data;
  try {
    const r = await fetch("https://aeroapi.flightaware.com/aeroapi/flights/" + ident + "?max_pages=1", { headers: { "x-apikey": env.AEROAPI_KEY, Accept: "application/json" } });
    if (!r.ok) return json({ error: "aeroapi", status: r.status }, r.status === 401 ? 401 : 502);
    data = await r.json();
  } catch (e) { return json({ error: "aeroapi unreachable" }, 502); }
  const list = Array.isArray(data.flights) ? data.flights : [];
  const now = Date.now(), t = s => (s ? Date.parse(s) : NaN);
  // the flight currently in the air, else the one scheduled closest to now
  let f = list.find(x => x.actual_off && !x.actual_on) ||
          list.slice().sort((a, b) => Math.abs(t(a.scheduled_out) - now) - Math.abs(t(b.scheduled_out) - now))[0];
  if (!f) return json({ error: "not_found" }, 404);
  const ap = a => a ? { iata: a.code_iata, icao: a.code_icao || a.code, name: a.name, city: a.city, tz: a.timezone } : null;
  const out = {
    ident: f.ident, ident_iata: f.ident_iata, status: f.status, progress: f.progress_percent,
    origin: ap(f.origin), destination: ap(f.destination),
    dep: { scheduled: f.scheduled_out, estimated: f.estimated_out, actual: f.actual_out, takeoff: f.actual_off || null, scheduled_takeoff: f.scheduled_off },
    arr: { scheduled: f.scheduled_in, estimated: f.estimated_in || f.estimated_on, actual: f.actual_in, landing: f.actual_on || null },
    delay_dep_min: f.departure_delay != null ? Math.round(f.departure_delay / 60) : null,
    delay_arr_min: f.arrival_delay != null ? Math.round(f.arrival_delay / 60) : null,
  };
  const body = JSON.stringify(out);
  await cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=600" } }));
  return new Response(body, { headers: { ...CORS, "Content-Type": "application/json" } });
}
