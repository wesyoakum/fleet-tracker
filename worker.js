// ============================================================
//  C-Track — Cloudflare Worker
//  Requires: KV namespace binding FLEET_KV
//  Optional: OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET env vars
// ============================================================
const ALLOWED_ORIGIN = "https://wesyoakum.github.io";
const MAX_FLEET_SIZE = 30;
const MAX_PINS = 50;
const MAX_FLIGHTS = 20;

// IATA → ICAO airline code mapping (common carriers)
const AIRLINE_MAP = {
  "AA":"AAL","UA":"UAL","DL":"DAL","WN":"SWA","AS":"ASA","B6":"JBU",
  "NK":"NKS","F9":"FFT","G4":"AAY","HA":"HAL","SY":"SCX","XP":"CXP",
  "BA":"BAW","LH":"DLH","AF":"AFR","KL":"KLM","EK":"UAE","QR":"QTR",
  "SQ":"SIA","CX":"CPA","QF":"QFA","AC":"ACA","WS":"WJA","AM":"AMX",
  "AV":"AVA","CM":"CMP","LA":"LAN","TP":"TAP","IB":"IBE","FR":"RYR",
  "U2":"EZY","W6":"WZZ","TK":"THY","ET":"ETH","SA":"SAA","NH":"ANA",
  "JL":"JAL","KE":"KAL","OZ":"AAR","CI":"CAL","BR":"EVA","MH":"MAS",
  "GA":"GIA","PR":"PAL","VN":"HVN","AI":"AIC","5X":"UPS","FX":"FDX",
};

// Seed data — written to KV on first access
const SEED_VESSELS = [
  { name: "Connor Bordelon",    mmsi: "367583170", slug: "connor-bordelon-mmsi-367583170-imo-9670626"      },
  { name: "Grand Canyon",       mmsi: "257031820", slug: "grand-canyon-mmsi-257031820-imo-0"               },
  { name: "Grand Canyon II",    mmsi: "257038580", slug: "grand-canyon-ii-mmsi-257038580-imo-9653874"      },
  { name: "Grant Candies",      mmsi: "368001000", slug: "grant-candies-mmsi-368001000-imo-0"              },
  { name: "Kilo Moana",         mmsi: "369565000", slug: "kilo-moana-mmsi-369565000-imo-9229037"           },
  { name: "Mary Sears",         mmsi: "303859000", slug: "mary-sears-mmsi-303859000-imo-9207077"           },
  { name: "Nautilus",           mmsi: "376404000", slug: "nautilus-mmsi-376404000-imo-0"                   },
  { name: "Ross Candies",       mmsi: "367426260", slug: "ross-candies-mmsi-367426260-imo-9481506"         },
  { name: "Shelia Bordelon",    mmsi: "367655260", slug: "shelia-bordelon-mmsi-367655260-imo-9670638"      },
  { name: "Skandi Constructor", mmsi: "257220000", slug: "skandi-constructor-mmsi-257220000-imo-0"         },
];

// ── Fleet KV helpers ──────────────────────────────────────────────────────────
async function getFleet(env) {
  const stored = await env.FLEET_KV.get("fleet", { type: "json" });
  if (stored && stored.length > 0) return stored;
  await env.FLEET_KV.put("fleet", JSON.stringify(SEED_VESSELS));
  return SEED_VESSELS;
}

async function putFleet(env, fleet) {
  await env.FLEET_KV.put("fleet", JSON.stringify(fleet));
}

// ── Pin KV helpers ────────────────────────────────────────────────────────────
async function getPins(env) {
  const stored = await env.FLEET_KV.get("pins", { type: "json" });
  return stored || [];
}

async function putPins(env, pins) {
  await env.FLEET_KV.put("pins", JSON.stringify(pins));
}

// ── Flight KV helpers ─────────────────────────────────────────────────────────
async function getFlights(env) {
  const stored = await env.FLEET_KV.get("flights", { type: "json" });
  return stored || [];
}

async function putFlights(env, flights) {
  await env.FLEET_KV.put("flights", JSON.stringify(flights));
}

// ── OpenSky OAuth2 ────────────────────────────────────────────────────────────
const OPENSKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const OPENSKY_API = "https://opensky-network.org/api";

let cachedToken = null;
let tokenExpiry = 0;

async function getOpenSkyToken(env) {
  const clientId = env.OPENSKY_CLIENT_ID;
  const clientSecret = env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(OPENSKY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
  });
  if (!res.ok) throw new Error(`OpenSky auth failed: HTTP ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000; // refresh 60s early
  return cachedToken;
}

function flightNumberToCallsign(flightNum) {
  // "UA2145" → "UAL2145", "AAL100" stays as-is
  const m = flightNum.toUpperCase().trim().match(/^([A-Z]{2,3})(\d+)$/);
  if (!m) return flightNum.toUpperCase().trim();
  const prefix = m[1];
  const num = m[2];
  // If already 3-letter ICAO, use as-is
  if (prefix.length === 3) return prefix + num;
  // Map 2-letter IATA to 3-letter ICAO
  return (AIRLINE_MAP[prefix] || prefix) + num;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    // GET / — health check
    if (url.pathname === "/") {
      const fleet = await getFleet(env);
      return json({ status: "ok", service: "FleetTrack Scraper", vessels: fleet.length });
    }

    // GET /search?name=X — search MyShipTracking by vessel name
    if (url.pathname === "/search" && request.method === "GET") {
      const query = url.searchParams.get("name");
      if (!query || query.trim().length < 2) {
        return json({ error: "Provide a 'name' parameter (at least 2 characters)" }, 400);
      }
      try {
        const results = await searchMyShipTracking(query.trim());
        return json(results);
      } catch (err) {
        return json({ error: `Search failed: ${err.message}` }, 502);
      }
    }

    // GET /vessels — fetch AIS data for all tracked vessels
    if (url.pathname === "/vessels" && request.method === "GET") {
      const fleet = await getFleet(env);
      const results = await Promise.all(fleet.map(v => scrapeVessel(v)));
      return json(results);
    }

    // POST /vessels — add a vessel to the fleet
    if (url.pathname === "/vessels" && request.method === "POST") {
      try {
        const body = await request.json();
        const { name, mmsi, slug } = body;
        if (!name || !mmsi || !slug) {
          return json({ error: "Required fields: name, mmsi, slug" }, 400);
        }
        const fleet = await getFleet(env);
        if (fleet.find(v => v.mmsi === mmsi)) {
          return json({ error: "Vessel already tracked", fleet }, 409);
        }
        if (fleet.length >= MAX_FLEET_SIZE) {
          return json({ error: `Fleet is at maximum size (${MAX_FLEET_SIZE} vessels)` }, 400);
        }
        fleet.push({ name, mmsi, slug });
        await putFleet(env, fleet);
        return json({ ok: true, fleet });
      } catch (err) {
        return json({ error: `Invalid request: ${err.message}` }, 400);
      }
    }

    // DELETE /vessels/:mmsi — remove a vessel from the fleet
    const delMatch = url.pathname.match(/^\/vessels\/(\d+)$/);
    if (delMatch && request.method === "DELETE") {
      const mmsi = delMatch[1];
      const fleet = await getFleet(env);
      const idx = fleet.findIndex(v => v.mmsi === mmsi);
      if (idx === -1) {
        return json({ error: "Vessel not found in fleet" }, 404);
      }
      fleet.splice(idx, 1);
      await putFleet(env, fleet);
      return json({ ok: true, fleet });
    }

    // GET /geocode?q=X — proxy geocoding via Nominatim
    if (url.pathname === "/geocode" && request.method === "GET") {
      const query = url.searchParams.get("q");
      if (!query || query.trim().length < 2) {
        return json({ error: "Provide a 'q' parameter (at least 2 characters)" }, 400);
      }
      try {
        const results = await geocode(query.trim());
        return json(results);
      } catch (err) {
        return json({ error: `Geocode failed: ${err.message}` }, 502);
      }
    }

    // GET /pins — return all saved pins
    if (url.pathname === "/pins" && request.method === "GET") {
      const pins = await getPins(env);
      return json(pins);
    }

    // POST /pins — add a pin { name, lat, lon }
    if (url.pathname === "/pins" && request.method === "POST") {
      try {
        const body = await request.json();
        const { name, lat, lon, color } = body;
        if (!name || lat == null || lon == null) {
          return json({ error: "Required fields: name, lat, lon" }, 400);
        }
        const pins = await getPins(env);
        if (pins.length >= MAX_PINS) {
          return json({ error: `Maximum ${MAX_PINS} pins reached` }, 400);
        }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const pin = { id, name, lat: parseFloat(lat), lon: parseFloat(lon) };
        if (color) pin.color = color;
        pins.push(pin);
        await putPins(env, pins);
        return json({ ok: true, pins });
      } catch (err) {
        return json({ error: `Invalid request: ${err.message}` }, 400);
      }
    }

    // DELETE /pins/:id — remove a pin
    const pinDelMatch = url.pathname.match(/^\/pins\/([a-z0-9]+)$/);
    if (pinDelMatch && request.method === "DELETE") {
      const id = pinDelMatch[1];
      const pins = await getPins(env);
      const idx = pins.findIndex(p => p.id === id);
      if (idx === -1) {
        return json({ error: "Pin not found" }, 404);
      }
      pins.splice(idx, 1);
      await putPins(env, pins);
      return json({ ok: true, pins });
    }

    // GET /flights — return tracked flights with live positions
    if (url.pathname === "/flights" && request.method === "GET") {
      try {
        let flights = await getFlights(env);
        if (!flights.length) return json([]);

        // Clean up landed flights older than 30 minutes
        const now = Date.now();
        const before = flights.length;
        flights = flights.filter(f => {
          if (f.landedAt && now - f.landedAt > 30 * 60 * 1000) return false;
          return true;
        });
        if (flights.length !== before) await putFlights(env, flights);

        // Fetch live positions from OpenSky
        const token = await getOpenSkyToken(env);
        if (!token) {
          return json(flights.map(f => ({ ...f, error: "OpenSky not configured" })));
        }

        const stateData = await fetchOpenSkyStates(token);
        if (!stateData) return json(flights.map(f => ({ ...f, error: "OpenSky unavailable" })));

        // Match flights by callsign
        let changed = false;
        const result = flights.map(f => {
          const cs = f.callsign.toUpperCase().trim();
          const sv = stateData.find(s => s[1] && s[1].trim().toUpperCase() === cs);
          if (sv) {
            const updated = {
              ...f,
              icao24: sv[0],
              lat: sv[6],
              lon: sv[5],
              altitude: sv[7] != null ? Math.round(sv[7] * 3.28084) : null, // meters → feet
              speed: sv[9] != null ? Math.round(sv[9] * 1.94384) : null, // m/s → knots
              heading: sv[10] != null ? Math.round(sv[10]) : null,
              verticalRate: sv[11] != null ? Math.round(sv[11] * 196.85) : null, // m/s → ft/min
              onGround: sv[8],
              lastSeen: sv[4],
              error: null,
            };
            if (sv[8] && !f.landedAt) { updated.landedAt = Date.now(); changed = true; }
            if (!sv[8] && f.landedAt) { updated.landedAt = null; changed = true; }
            return updated;
          }
          return { ...f, lat: null, lon: null, error: "Not airborne" };
        });

        if (changed) {
          await putFlights(env, result.map(f => ({
            callsign: f.callsign, label: f.label, addedAt: f.addedAt, landedAt: f.landedAt || null,
          })));
        }
        return json(result);
      } catch (err) {
        return json({ error: `Flight fetch failed: ${err.message}` }, 502);
      }
    }

    // POST /flights — add a flight to track
    if (url.pathname === "/flights" && request.method === "POST") {
      try {
        const body = await request.json();
        const { flightNumber, label } = body;
        if (!flightNumber) return json({ error: "Required: flightNumber" }, 400);
        const callsign = flightNumberToCallsign(flightNumber);
        let flights = await getFlights(env);
        if (flights.find(f => f.callsign === callsign)) {
          return json({ error: "Flight already tracked", flights }, 409);
        }
        if (flights.length >= MAX_FLIGHTS) {
          return json({ error: `Maximum ${MAX_FLIGHTS} tracked flights` }, 400);
        }
        flights.push({
          callsign,
          label: label || flightNumber.toUpperCase(),
          addedAt: Date.now(),
          landedAt: null,
        });
        await putFlights(env, flights);
        return json({ ok: true, flights });
      } catch (err) {
        return json({ error: `Invalid request: ${err.message}` }, 400);
      }
    }

    // DELETE /flights/:callsign — remove a tracked flight
    const flightDelMatch = url.pathname.match(/^\/flights\/([A-Z0-9]+)$/i);
    if (flightDelMatch && request.method === "DELETE") {
      const callsign = flightDelMatch[1].toUpperCase();
      let flights = await getFlights(env);
      const idx = flights.findIndex(f => f.callsign === callsign);
      if (idx === -1) return json({ error: "Flight not found" }, 404);
      flights.splice(idx, 1);
      await putFlights(env, flights);
      return json({ ok: true, flights });
    }

    return json({ error: "Not found" }, 404);
  },
};

// ── Search MyShipTracking ─────────────────────────────────────────────────────
async function searchMyShipTracking(query) {
  const searchUrl = `https://www.myshiptracking.com/vessels?name=${encodeURIComponent(query)}&page=1&pp=50`;
  const res = await fetch(searchUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`MyShipTracking returned HTTP ${res.status}`);
  const html = await res.text();
  return parseSearchResults(html);
}

function parseSearchResults(html) {
  const results = [];
  // Match table rows containing vessel links like /vessels/vessel-name-mmsi-123456789-imo-0
  // Each row has: flag, name (linked), MMSI, type, area, speed, destination, received
  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const rows = html.match(rowRegex) || [];

  for (const row of rows) {
    // Look for vessel link
    const linkMatch = row.match(/href="\/vessels\/([\w-]+)"/i);
    if (!linkMatch) continue;
    const slug = linkMatch[1];

    // Extract MMSI from slug (pattern: ...-mmsi-XXXXXXXXX-imo-...)
    const mmsiMatch = slug.match(/mmsi-(\d+)/);
    if (!mmsiMatch) continue;
    const mmsi = mmsiMatch[1];

    // Extract vessel name from the link text
    const nameMatch = row.match(/href="\/vessels\/[\w-]+"[^>]*>\s*([^<]+)<\/a>/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    // Extract flag from img title attribute
    let flag = "";
    const flagMatch = row.match(/<img[^>]*title="([^"]+)"/i);
    if (flagMatch) flag = flagMatch[1].trim();

    // Extract fields from td cells
    // Columns: 0=Flag+Name, 1=MMSI, 2=Type, 3=Area, 4=Speed, 5=Destination, 6=Received
    const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    const cellText = (i) => (cells[i] || "").replace(/<[^>]+>/g, "").trim();
    const type = cellText(2);
    const area = cellText(3);
    const speed = cellText(4);
    const destination = cellText(5);

    results.push({ name, mmsi, slug, flag, type, area, speed, destination });

    if (results.length >= 20) break;
  }

  return results;
}

// ── OpenSky state vectors ─────────────────────────────────────────────────────
async function fetchOpenSkyStates(token) {
  const res = await fetch(`${OPENSKY_API}/states/all`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.states || [];
}

// ── Geocode via Nominatim ─────────────────────────────────────────────────────
async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=8&addressdetails=1`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "FleetTrack/1.0 (vessel tracking app)",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Nominatim returned HTTP ${res.status}`);
  const data = await res.json();
  return data.map(r => ({
    name: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    type: r.type,
    category: r.category,
  }));
}

// ── Scrape a single vessel page ───────────────────────────────────────────────
async function scrapeVessel(vessel) {
  const pageUrl = `https://www.myshiptracking.com/vessels/${vessel.slug}`;
  try {
    const res = await fetch(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // ── COORDINATES ─────────────────────────────────────────────────────────
    let lat = null, lon = null;
    const p1 = html.match(/coordinates\s+([-\d.]+)°?\s*\/\s*([-\d.]+)°?/i);
    if (p1) { lat = parseFloat(p1[1]); lon = parseFloat(p1[2]); }
    if (lat === null) {
      const latMatch = html.match(/Latitude[\s\S]{0,80}?<\/td>\s*<td[^>]*>\s*([-\d.]+)/i);
      const lonMatch = html.match(/Longitude[\s\S]{0,80}?<\/td>\s*<td[^>]*>\s*([-\d.]+)/i);
      if (latMatch && lonMatch) { lat = parseFloat(latMatch[1]); lon = parseFloat(lonMatch[1]); }
    }
    if (lat === null) {
      const jsonLd = html.match(/"latitude"\s*:\s*([-\d.]+)/i);
      const jsonLn = html.match(/"longitude"\s*:\s*([-\d.]+)/i);
      if (jsonLd && jsonLn) { lat = parseFloat(jsonLd[1]); lon = parseFloat(jsonLn[1]); }
    }
    if (lat === null) {
      const evtMatch = html.match(/([-]?\d{1,3}\.\d{3,6})\s*\/\s*([-]?\d{1,3}\.\d{3,6})/);
      if (evtMatch) {
        const mayLat = parseFloat(evtMatch[1]);
        const mayLon = parseFloat(evtMatch[2]);
        if (mayLat >= -90 && mayLat <= 90 && mayLon >= -180 && mayLon <= 180) {
          lat = mayLat; lon = mayLon;
        }
      }
    }

    // ── SPEED ───────────────────────────────────────────────────────────────
    let speed = 0;
    const sp1 = html.match(/current speed is\s*([\d.]+)\s*[Kk]nots?/);
    const sp2 = html.match(/Speed<\/td>\s*<td[^>]*>\s*([\d.]+)/i);
    const sp3 = html.match(/speed[:\s]+([\d.]+)\s*kn/i);
    if (sp1) speed = parseFloat(sp1[1]);
    else if (sp2) speed = parseFloat(sp2[1]);
    else if (sp3) speed = parseFloat(sp3[1]);

    // ── COURSE ──────────────────────────────────────────────────────────────
    let course = 0;
    const co1 = html.match(/Course<\/td>\s*<td[^>]*>\s*([\d.]+)°?/i);
    const co2 = html.match(/[Cc]ourse[:\s]+([\d.]+)°/);
    if (co1) course = parseFloat(co1[1]);
    else if (co2) course = parseFloat(co2[1]);

    // ── NAV STATUS ──────────────────────────────────────────────────────────
    const navStatus = extractStatus(html);

    // ── AREA ────────────────────────────────────────────────────────────────
    let area = "\u2014";
    const ar1 = html.match(/Area<\/td>\s*<td[^>]*>\s*([^<]{2,50})<\/td>/i);
    if (ar1) area = ar1[1].trim();

    // ── LAST RECEIVED ───────────────────────────────────────────────────────
    let received = "\u2014";
    const rc1 = html.match(/Position Received<\/td>\s*<td[^>]*>\s*([^<]{3,50})<\/td>/i);
    if (rc1) received = rc1[1].trim();

    // ── OUT OF COVERAGE ─────────────────────────────────────────────────────
    const outOfCoverage = /out of coverage/i.test(html);

    return {
      mmsi: vessel.mmsi, name: vessel.name, slug: vessel.slug,
      lat, lon, speed, course, navStatus, area, received, outOfCoverage, error: null,
    };
  } catch (err) {
    return {
      mmsi: vessel.mmsi, name: vessel.name, slug: vessel.slug,
      lat: null, lon: null, speed: 0, course: 0,
      navStatus: "Unknown", area: "\u2014", received: "\u2014",
      outOfCoverage: false, error: err.message,
    };
  }
}

// ── Extract nav status ────────────────────────────────────────────────────────
function extractStatus(html) {
  const m = html.match(/Status<\/(?:td|th)[^>]*>\s*<(?:td|th)[^>]*>\s*([^<]{2,50})<\//i);
  if (m) return m[1].trim();
  if (/[Mm]oored/.test(html))                return "Moored";
  if (/[Aa]t\s+anchor/.test(html))           return "At anchor";
  if (/[Uu]nder\s+way\s+using\s+engine/i.test(html)) return "Under way using engine";
  if (/[Uu]nderway/.test(html))              return "Underway";
  if (/[Aa]nchored/.test(html))              return "At anchor";
  return "Unknown";
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
