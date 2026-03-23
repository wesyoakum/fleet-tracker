// ============================================================
//  FleetTrack — MyShipTracking Scraper (Cloudflare Worker)
//  Requires KV namespace binding: FLEET_KV
// ============================================================
const ALLOWED_ORIGIN = "https://wesyoakum.github.io";
const MAX_FLEET_SIZE = 30;

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
