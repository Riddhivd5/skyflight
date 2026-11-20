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
//   GET  /api/trace?hex=800abc                       full flown track of the current flight (community ADS-B traces)
//   GET  /api/place?lat=12.97&lon=77.59              city name for the start screen (OpenStreetMap Nominatim)
//   GET  /api/airport?code=HYD&dir=dep|arr           departures / arrivals board (AeroDataBox or FlightAware)
//
// Airport boards need ONE of these secrets (Settings → Variables and Secrets → Add → Type: Secret):
//   AERODATABOX_KEY  your RapidAPI key for AeroDataBox (free Basic plan)  ← recommended, one request per board
//   AEROAPI_KEY      the FlightAware key (also used for flight times)
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
    if (u.pathname === "/api/trace") return trace(u.searchParams.get("hex") || "");
    if (u.pathname === "/api/place") return place(u.searchParams.get("lat"), u.searchParams.get("lon"));
    if (u.pathname === "/api/airport") return airportBoard(u.searchParams.get("code") || "", u.searchParams.get("dir") === "arr" ? "arr" : "dep", env);
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

// ---------- full flown track for one aircraft ----------
// readsb/tar1090 trace files: { timestamp, trace: [[dt, lat, lon, alt_ft|"ground", gs, track, flags, vrate, ...], ...] }
const TRACE_HOSTS = [["https://globe.adsb.lol", "adsb.lol"], ["https://globe.airplanes.live", "airplanes.live"], ["https://globe.adsb.fi", "adsb.fi"]];
async function readJsonMaybeGzip(r) {
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const txt = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return JSON.parse(txt);
  }
  return JSON.parse(new TextDecoder().decode(buf));
}
function tracePoints(j) {
  if (!j || !Array.isArray(j.trace)) return [];
  const t0 = j.timestamp || 0;
  return j.trace.filter(e => typeof e[1] === "number" && typeof e[2] === "number")
    .map(e => [t0 + e[0], +e[1].toFixed(5), +e[2].toFixed(5), e[3] === "ground" ? 0 : (typeof e[3] === "number" ? e[3] : null), e[6] || 0, e[3] === "ground"]);
}
async function trace(hex) {
  hex = hex.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 6);
  if (hex.length !== 6) return json({ error: "hex required" }, 400);
  const cache = caches.default, key = new Request("https://cache.skyflight.internal/trace/" + hex);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { ...CORS, "Content-Type": "application/json" } });
  let pts = [], source = null;
  for (const [host, name] of TRACE_HOSTS) {
    const got = [];
    for (const kind of ["full", "recent"]) {
      try {
        const r = await fetch(`${host}/data/traces/${hex.slice(-2)}/trace_${kind}_${hex}.json`,
          { headers: { ...UA, Referer: host + "/", Accept: "application/json" }, cf: { cacheTtl: 30 } });
        if (r.ok) got.push(...tracePoints(await readJsonMaybeGzip(r)));
      } catch (e) {}
    }
    if (got.length) { pts = got; source = name; break; }
  }
  if (!pts.length) { // last resort: OpenSky track of the current flight
    try {
      const r = await fetch("https://opensky-network.org/api/tracks/all?icao24=" + hex + "&time=0", { headers: UA });
      if (r.ok) {
        const j = await r.json();
        pts = (j.path || []).map(e => [e[0], e[1], e[2], e[5] ? 0 : (e[3] != null ? Math.round(e[3] / 0.3048) : null), 0, !!e[5]]);
        source = "opensky";
      }
    } catch (e) {}
  }
  if (!pts.length) return json({ error: "no_trace" }, 404);
  // de-duplicate, sort, keep only the current flight (since the last take-off / new-leg marker / long gap)
  pts.sort((a, b) => a[0] - b[0]);
  pts = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0]);
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i][0] - pts[i - 1][0];
    if ((pts[i][4] & 2) || gap > 25 * 60 || (pts[i - 1][5] && !pts[i][5])) start = i;
  }
  // include the take-off roll if the leg began on the ground
  if (start > 0 && pts[start - 1][5] && pts[start][0] - pts[start - 1][0] < 600) start--;
  let leg = pts.slice(start).filter(p => !p[5] || p === pts[start]);
  // thin out to at most ~700 points
  const step = Math.ceil(leg.length / 700);
  if (step > 1) leg = leg.filter((p, i) => i % step === 0 || i === leg.length - 1);
  const body = JSON.stringify({ source, points: leg.map(p => [p[0], p[1], p[2], p[3]]) });
  await cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=45" } }));
  return new Response(body, { headers: { ...CORS, "Content-Type": "application/json" } });
}

// ---------- city name for a location (cached a day; ~1 km grid so nearby users share it) ----------
async function place(lat, lon) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: "lat/lon required" }, 400);
  const la = lat.toFixed(2), lo = lon.toFixed(2);
  const cache = caches.default, key = new Request("https://cache.skyflight.internal/place/" + la + "," + lo);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${la}&lon=${lo}`,
      { headers: { "User-Agent": "SkyFlight/1.0 (personal flight-spotting app)" } });
    const j = await r.json(), a = j.address || {};
    const name = a.city || a.town || a.municipality || a.county || a.state_district || a.state || null;
    const body = JSON.stringify({ name });
    await cache.put(key, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" } }));
    return new Response(body, { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) { return json({ name: null }, 200); }
}

// ---------- airport departures / arrivals board ----------
// Normalised row: { flight, callsign, airline, other:{code,name,city}, sched, est, actual, gate, terminal, status, aircraft, reg, cancelled }
async function airportBoard(code, dir, env) {
  code = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  if (code.length < 3) return json({ error: "airport code required" }, 400);
  const provider = env && env.AERODATABOX_KEY ? "aerodatabox" : env && env.AEROAPI_KEY ? "flightaware" : null;
  if (!provider) return json({ error: "no_key" }, 501);
  const cache = caches.default, key = new Request(`https://cache.skyflight.internal/board/${provider}/${code}/${provider === "aerodatabox" ? "both" : dir}`);
  const hit = await cache.match(key);
  let data = hit ? await hit.json() : null;
  if (!data) {
    try { data = provider === "aerodatabox" ? await boardADB(code, env.AERODATABOX_KEY) : await boardFA(code, dir, env.AEROAPI_KEY); }
    catch (e) { return json({ error: "provider", detail: String(e.message || e) }, 502); }
    await cache.put(key, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" } }));
  }
  const rows = (dir === "arr" ? data.arrivals : data.departures) || [];
  return json({ code, dir, source: provider, tz: data.tz || null, name: data.name || null, rows });
}
async function boardADB(code, apiKey) {
  const host = "aerodatabox.p.rapidapi.com", type = code.length === 4 ? "icao" : "iata";
  const headers = { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": host, Accept: "application/json" };
  const q = "direction=Both&withLeg=false&withCancelled=true&withCodeshared=false&withCargo=true&withPrivate=true&withLocation=false";
  // relative window: 1 h ago → 6 h ahead
  let r = await fetch(`https://${host}/flights/airports/${type}/${code}?offsetMinutes=-60&durationMinutes=420&${q}`, { headers });
  if (r.status === 404 || r.status === 400) { // fall back to the absolute-time form (local time; India assumed if unknown)
    const loc = d => new Date(d.getTime() + 330 * 60e3).toISOString().slice(0, 16);
    const now = new Date();
    r = await fetch(`https://${host}/flights/airports/${type}/${code}/${loc(new Date(now - 60 * 60e3))}/${loc(new Date(+now + 6 * 3600e3))}?${q}`, { headers });
  }
  if (!r.ok) throw new Error("AeroDataBox HTTP " + r.status);
  const j = await r.json();
  const row = (f, side) => {
    const m = f.movement || f[side] || {}, ap = m.airport || {};
    return { flight: f.number || "", callsign: f.callSign || "", airline: (f.airline && f.airline.name) || "",
      other: { code: ap.iata || ap.icao || "", name: ap.name || "", city: ap.municipalityName || ap.shortName || ap.name || "" },
      sched: m.scheduledTime && m.scheduledTime.utc, est: m.revisedTime && m.revisedTime.utc, actual: m.runwayTime && m.runwayTime.utc,
      gate: m.gate || "", terminal: m.terminal || "", status: f.status || "", aircraft: (f.aircraft && f.aircraft.model) || "", reg: (f.aircraft && f.aircraft.reg) || "",
      cancelled: /cancel/i.test(f.status || "") };
  };
  const fix = s => s ? s.replace(" ", "T").replace(/Z?$/, "Z") : s; // "2026-11-20 06:40Z" → ISO
  const norm = r => Object.assign(r, { sched: fix(r.sched), est: fix(r.est), actual: fix(r.actual) });
  return { departures: (j.departures || []).map(f => norm(row(f, "departure"))), arrivals: (j.arrivals || []).map(f => norm(row(f, "arrival"))) };
}
async function boardFA(code, dir, apiKey) {
  const base = "https://aeroapi.flightaware.com/aeroapi/airports/" + code + "/flights/";
  const headers = { "x-apikey": apiKey, Accept: "application/json" };
  const now = Date.now(), iso = t => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
  const kinds = dir === "dep" ? ["departures", "scheduled_departures"] : ["arrivals", "scheduled_arrivals"];
  const out = [];
  for (const k of kinds) {
    const win = k.startsWith("scheduled") ? `start=${iso(now - 30 * 60e3)}&end=${iso(now + 6 * 3600e3)}` : `start=${iso(now - 90 * 60e3)}&end=${iso(now)}`;
    const r = await fetch(base + k + "?max_pages=1&" + win, { headers });
    if (!r.ok) throw new Error("FlightAware HTTP " + r.status);
    const j = await r.json();
    for (const f of (j[k] || [])) {
      const dep = dir === "dep", ap = dep ? f.destination : f.origin;
      out.push({ flight: f.ident_iata || f.ident || "", callsign: f.ident_icao || f.ident || "", airline: f.operator_iata || f.operator || "",
        other: { code: ap ? (ap.code_iata || ap.code_icao || ap.code || "") : "", name: ap ? ap.name || "" : "", city: ap ? ap.city || "" : "" },
        sched: dep ? f.scheduled_out : f.scheduled_in, est: dep ? f.estimated_out : f.estimated_in, actual: dep ? (f.actual_out || f.actual_off) : (f.actual_in || f.actual_on),
        gate: dep ? f.gate_origin || "" : f.gate_destination || "", terminal: dep ? f.terminal_origin || "" : f.terminal_destination || "",
        status: f.status || "", aircraft: f.aircraft_type || "", reg: f.registration || "", cancelled: !!f.cancelled, tz: (dep ? f.origin : f.destination || {}) ? (dep ? f.origin && f.origin.timezone : f.destination && f.destination.timezone) : null });
    }
  }
  const seen = new Set(), rows = out.filter(r => { const k = r.flight + r.sched; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => Date.parse(a.sched || 0) - Date.parse(b.sched || 0));
  const tz = (rows.find(r => r.tz) || {}).tz || null;
  return dir === "dep" ? { departures: rows, tz } : { arrivals: rows, tz };
}
