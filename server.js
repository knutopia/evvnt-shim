/**
 * Event Calendar Middleware Shim
 *
 * Fetches events from Ticketmaster Discovery API (swap for Evvnt later),
 * filters by presenter/venue per client config, and serves XML matching
 * the legacy DMN feed schema.
 *
 * Usage:
 *   npm install
 *   npm start
 *   npm start -- --verbose
 *
 * Endpoints:
 *   GET /feed/:clientId.xml   → Filtered XML feed (e.g., /feed/attpac.xml)
 *   GET /feed/:clientId.json  → Filtered JSON feed
 *   GET /status               → Cache status and diagnostics
 *   POST /sync                → Trigger manual sync
 */

require("dotenv").config();

const express = require("express");
const cron = require("node-cron");
const { create } = require("xmlbuilder2");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ─── Configuration ───────────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const PORT = config.server.port || 3000;
if (process.env.TICKETMASTER_API_KEY) config.ticketmaster.apiKey = process.env.TICKETMASTER_API_KEY;
const USE_MOCK = config.ticketmaster.apiKey === "YOUR_TICKETMASTER_API_KEY";
const VERBOSE_SYNC = process.argv.includes("-v") || process.argv.includes("--verbose");

// ─── In-Memory Cache ─────────────────────────────────────────────────────────

let cache = {
  events: [],
  categories: {},
  lastSync: null,
  lastSyncDuration: null,
  syncCount: 0,
  errors: [],
};

// ─── Ticketmaster API Client ─────────────────────────────────────────────────

/**
 * Fetch a single page of events from Ticketmaster Discovery API.
 */
function fetchTicketmasterPage(pageNumber) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      apikey: config.ticketmaster.apiKey,
      countryCode: config.ticketmaster.countryCode || "US",
      stateCode: config.ticketmaster.stateCode || "TX",
      dmaId: config.ticketmaster.dmaId || "261",
      size: String(config.ticketmaster.maxResultsPerPage || 100),
      page: String(pageNumber),
      sort: "date,asc",
      classificationName: "Arts & Theatre,Music",
    });

    const url = `${config.ticketmaster.baseUrl}/events.json?${params}`;

    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Fetch all events with automatic pagination.
 */
async function fetchAllEvents(syncStats) {
  const allEvents = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages) {
    console.log(`  Fetching page ${page + 1}${totalPages > 1 ? ` of ${totalPages}` : ""}...`);

    syncStats.apiRequests++;
    const response = await fetchTicketmasterPage(page);
    syncStats.pagesFetched++;

    if (response.fault) {
      throw new Error(`API error: ${response.fault.faultstring}`);
    }

    if (response._embedded && response._embedded.events) {
      allEvents.push(...response._embedded.events);
    }
    syncStats.retrievedTotal = allEvents.length;

    if (response.page) {
      totalPages = Math.min(response.page.totalPages || 1, 5); // Cap at 5 pages for dev
    }

    page++;

    // Rate limit: Ticketmaster allows 5 req/sec, be conservative
    if (page < totalPages) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return allEvents;
}

/**
 * Normalize a Ticketmaster event into our internal format.
 * This is the adapter layer — swap this function for Evvnt normalization later.
 */
function normalizeTicketmasterEvent(tm) {
  const venue = tm._embedded?.venues?.[0] || {};
  const attractions = tm._embedded?.attractions || [];
  const promoter = tm.promoter || {};
  const classifications = tm.classifications?.[0] || {};

  // Build presenter name from promoter or first attraction
  const presenter =
    promoter.name && promoter.name !== "N/A"
      ? promoter.name
      : attractions[0]?.name || "Unknown Presenter";

  // Extract ticket URL
  const ticketUrl = tm.url || "";

  // Extract price
  const priceRange = tm.priceRanges?.[0] || {};
  const price = priceRange.min ? String(priceRange.min) : "";

  // Build performances array from dates
  // Ticketmaster returns one event per date, but some have multiple showtimes
  const performances = [];
  if (tm.dates?.start) {
    const dateStr = tm.dates.start.localDate || "";
    const timeStr = tm.dates.start.localTime || "00:00:00";
    if (dateStr) {
      performances.push(`${dateStr} ${timeStr}`);
    }
  }

  return {
    id: tm.id || "",
    title: tm.name || "",
    image: tm.images?.[0]?.url || "",
    description: tm.info || tm.pleaseNote || tm.name || "",
    link: tm.url || "",
    venue: {
      name: venue.name || "",
      address: venue.address?.line1 || "",
      city: venue.city?.name || "",
      state: venue.state?.stateCode || "",
      zipCode: venue.postalCode || "",
    },
    presenter: presenter,
    presenterWebsite: attractions[0]?.url || "",
    startDate: tm.dates?.start?.localDate || "",
    endDate: tm.dates?.end?.localDate || tm.dates?.start?.localDate || "",
    performances: performances,
    category: classifications.genre?.name || classifications.segment?.name || "General",
    ongoing: (tm.dates?.end?.localDate || "") > (tm.dates?.start?.localDate || ""),
    ticketUrl: ticketUrl,
    price: price,

    // Keep raw fields for flexible filtering
    _raw: {
      promoterName: promoter.name || "",
      attractionNames: attractions.map((a) => a.name),
      venueName: venue.name || "",
    },
  };
}

// ─── Mock Data (used when no API key is configured) ──────────────────────────

function generateMockEvents() {
  const now = new Date();
  const mockEvents = [
    {
      id: "mock-001",
      title: "The Music Man",
      image: "https://placehold.co/760x570/1B4F72/white?text=The+Music+Man",
      description: "Meredith Willson's six-time Tony Award-winning musical comedy follows fast-talking traveling salesman Harold Hill.",
      link: "https://example.com/event/mock-001",
      venue: { name: "Winspear Opera House", address: "2403 Flora St.", city: "Dallas", state: "TX", zipCode: "75201" },
      presenter: "AT&T Performing Arts Center",
      presenterWebsite: "https://www.attpac.org/",
      startDate: formatDate(now, 0),
      endDate: formatDate(now, 2),
      performances: [
        `${formatDate(now, 0)} 19:30:00`,
        `${formatDate(now, 1)} 14:00:00`,
        `${formatDate(now, 1)} 20:00:00`,
        `${formatDate(now, 2)} 14:00:00`,
      ],
      category: "Musical Theater",
      ongoing: true,
      ticketUrl: "https://example.com/tickets/mock-001",
      price: "89",
      _raw: { promoterName: "AT&T Performing Arts Center", attractionNames: ["The Music Man"], venueName: "Winspear Opera House" },
    },
    {
      id: "mock-002",
      title: "Danny Elfman's Music from the Films of Tim Burton",
      image: "https://placehold.co/760x570/2E86C1/white?text=Danny+Elfman",
      description: "Danny Elfman's famous Tim Burton film scores brought to life on stage by orchestra.",
      link: "https://example.com/event/mock-002",
      venue: { name: "Morton H. Meyerson Symphony Center", address: "2301 Flora St.", city: "Dallas", state: "TX", zipCode: "75201" },
      presenter: "Dallas Symphony Orchestra",
      presenterWebsite: "https://www.mydso.com",
      startDate: formatDate(now, 1),
      endDate: formatDate(now, 3),
      performances: [
        `${formatDate(now, 1)} 19:30:00`,
        `${formatDate(now, 2)} 19:30:00`,
        `${formatDate(now, 3)} 14:00:00`,
      ],
      category: "Music",
      ongoing: true,
      ticketUrl: "https://www.dallassymphony.org/",
      price: "249",
      _raw: { promoterName: "Dallas Symphony Orchestra", attractionNames: ["Danny Elfman"], venueName: "Morton H. Meyerson Symphony Center" },
    },
    {
      id: "mock-003",
      title: "Il Divo by Candlelight",
      image: "https://placehold.co/760x570/8E44AD/white?text=Il+Divo",
      description: "A journey through two decades of romance, heartache, and joy.",
      link: "https://example.com/event/mock-003",
      venue: { name: "Majestic Theatre", address: "1925 Elm St.", city: "Dallas", state: "TX", zipCode: "75201" },
      presenter: "AT&T Performing Arts Center",
      presenterWebsite: "https://www.attpac.org/",
      startDate: formatDate(now, 2),
      endDate: formatDate(now, 2),
      performances: [`${formatDate(now, 2)} 19:30:00`],
      category: "Instrumental",
      ongoing: false,
      ticketUrl: "",
      price: "",
      _raw: { promoterName: "AT&T Performing Arts Center", attractionNames: ["Il Divo"], venueName: "Majestic Theatre" },
    },
    {
      id: "mock-004",
      title: "Swan Lake",
      image: "https://placehold.co/760x570/27AE60/white?text=Swan+Lake",
      description: "Tchaikovsky's timeless ballet performed by Texas Ballet Theater.",
      link: "https://example.com/event/mock-004",
      venue: { name: "Winspear Opera House", address: "2403 Flora St.", city: "Dallas", state: "TX", zipCode: "75201" },
      presenter: "Texas Ballet Theater",
      presenterWebsite: "https://www.texasballettheater.org/",
      startDate: formatDate(now, 5),
      endDate: formatDate(now, 7),
      performances: [
        `${formatDate(now, 5)} 19:30:00`,
        `${formatDate(now, 6)} 14:00:00`,
        `${formatDate(now, 6)} 19:30:00`,
        `${formatDate(now, 7)} 14:00:00`,
      ],
      category: "Dance",
      ongoing: true,
      ticketUrl: "https://example.com/tickets/mock-004",
      price: "75",
      _raw: { promoterName: "Texas Ballet Theater", attractionNames: ["Swan Lake"], venueName: "Winspear Opera House" },
    },
    {
      id: "mock-005",
      title: "La Traviata",
      image: "https://placehold.co/760x570/C0392B/white?text=La+Traviata",
      description: "Verdi's beloved opera of love and sacrifice in a stunning new production.",
      link: "https://example.com/event/mock-005",
      venue: { name: "Winspear Opera House", address: "2403 Flora St.", city: "Dallas", state: "TX", zipCode: "75201" },
      presenter: "The Dallas Opera",
      presenterWebsite: "https://www.dallasopera.org/",
      startDate: formatDate(now, 8),
      endDate: formatDate(now, 12),
      performances: [
        `${formatDate(now, 8)} 19:30:00`,
        `${formatDate(now, 10)} 19:30:00`,
        `${formatDate(now, 12)} 14:00:00`,
      ],
      category: "Opera",
      ongoing: true,
      ticketUrl: "https://example.com/tickets/mock-005",
      price: "59",
      _raw: { promoterName: "The Dallas Opera", attractionNames: ["La Traviata"], venueName: "Winspear Opera House" },
    },
    {
      id: "mock-006",
      title: "Frida Kahlo: Life of an Icon",
      image: "https://placehold.co/760x570/F39C12/white?text=Frida+Kahlo",
      description: "Immersive biography experience featuring projections, original music, and rare artifacts.",
      link: "https://example.com/event/mock-006",
      venue: { name: "Latino Cultural Center", address: "2600 Live Oak St.", city: "Dallas", state: "TX", zipCode: "75204" },
      presenter: "Teatro Dallas",
      presenterWebsite: "https://www.teatrodallas.org/",
      startDate: formatDate(now, 3),
      endDate: formatDate(now, 30),
      performances: [`${formatDate(now, 3)} 10:00:00`],
      category: "Exhibit",
      ongoing: true,
      ticketUrl: "",
      price: "25",
      _raw: { promoterName: "Teatro Dallas", attractionNames: ["Frida Kahlo"], venueName: "Latino Cultural Center" },
    },
    {
      id: "mock-007",
      title: "Jazz at the Museum",
      image: "https://placehold.co/760x570/1ABC9C/white?text=Jazz+Night",
      description: "Live jazz performances in the atrium every Friday evening.",
      link: "https://example.com/event/mock-007",
      venue: { name: "Dallas Museum of Art", address: "1717 N. Harwood St.", city: "Dallas", state: "TX", zipCode: "75201" },
      presenter: "Dallas Museum of Art",
      presenterWebsite: "https://www.dma.org/",
      startDate: formatDate(now, 4),
      endDate: formatDate(now, 4),
      performances: [`${formatDate(now, 4)} 18:00:00`],
      category: "Music",
      ongoing: false,
      ticketUrl: "",
      price: "",
      _raw: { promoterName: "Dallas Museum of Art", attractionNames: [], venueName: "Dallas Museum of Art" },
    },
    {
      id: "mock-008",
      title: "Random Concert Downtown",
      image: "https://placehold.co/760x570/95A5A6/white?text=Random+Concert",
      description: "This event should be filtered OUT — presenter and venue are not in the OAC list.",
      link: "https://example.com/event/mock-008",
      venue: { name: "Some Random Bar", address: "999 Main St.", city: "Dallas", state: "TX", zipCode: "75201" },
      presenter: "Unknown Promotions LLC",
      presenterWebsite: "",
      startDate: formatDate(now, 2),
      endDate: formatDate(now, 2),
      performances: [`${formatDate(now, 2)} 21:00:00`],
      category: "Music",
      ongoing: false,
      ticketUrl: "",
      price: "15",
      _raw: { promoterName: "Unknown Promotions LLC", attractionNames: [], venueName: "Some Random Bar" },
    },
  ];

  return mockEvents;
}

function formatDate(base, offsetDays) {
  const d = new Date(base);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().split("T")[0];
}

// ─── Sync Engine ─────────────────────────────────────────────────────────────

async function syncEvents(trigger = "manual") {
  const startTime = Date.now();
  const syncStats = {
    apiRequests: 0,
    pagesFetched: 0,
    retrievedTotal: 0,
  };

  console.log(`\n[${new Date().toISOString()}] Starting event sync...`);

  try {
    let events;

    if (USE_MOCK) {
      console.log("  Using MOCK data (no API key configured)");
      events = generateMockEvents();
      syncStats.retrievedTotal = events.length;
    } else {
      const rawEvents = await fetchAllEvents(syncStats);
      console.log(`  Fetched ${rawEvents.length} raw events from Ticketmaster`);
      events = rawEvents.map(normalizeTicketmasterEvent);
    }

    cache.events = events;
    cache.lastSync = new Date().toISOString();
    cache.lastSyncDuration = Date.now() - startTime;
    cache.syncCount++;
    cache.errors = [];

    console.log(`  Cached ${events.length} events (${cache.lastSyncDuration}ms)`);
    logVerboseSyncSummary({
      trigger,
      durationMs: cache.lastSyncDuration,
      syncStats,
      events,
    });
    console.log(`  Sync complete.\n`);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    console.error(`  Sync FAILED: ${err.message}`);
    cache.errors.push({ time: new Date().toISOString(), message: err.message });
    logVerboseSyncFailure({
      trigger,
      durationMs,
      syncStats,
      error: err,
    });
  }
}

// ─── Filtering ───────────────────────────────────────────────────────────────

/**
 * Case-insensitive substring match against a list of allowed values.
 * Returns true if `value` contains any entry in `allowList` or vice versa.
 */
function matchesAny(value, allowList) {
  if (!value || !allowList || allowList.length === 0) return false;
  const lower = value.toLowerCase().trim();
  return allowList.some((allowed) => {
    const a = allowed.toLowerCase().trim();
    return lower.includes(a) || a.includes(lower);
  });
}

function getClientMatchDetails(event, clientConfig) {
  const presenterMatch = matchesAny(event.presenter, clientConfig.presenters) ||
    matchesAny(event._raw?.promoterName, clientConfig.presenters) ||
    (event._raw?.attractionNames || []).some((name) => matchesAny(name, clientConfig.presenters));

  const venueMatch = matchesAny(event.venue.name, clientConfig.venues) ||
    matchesAny(event._raw?.venueName, clientConfig.venues);

  return {
    presenterMatch,
    venueMatch,
    eitherMatch: presenterMatch || venueMatch,
  };
}

function countEventXmlRows(event) {
  return event.performances.length > 0 ? event.performances.length : 1;
}

function collectVerboseSyncMetrics(events) {
  const matchedEventIndexes = new Set();
  const clientSummaries = [];
  const startDates = [];
  const endDates = [];
  const seenIds = new Set();
  let duplicateIds = 0;

  const missingFields = {
    title: 0,
    presenter: 0,
    venue: 0,
    startDate: 0,
  };

  for (const event of events) {
    if (event.startDate) {
      startDates.push(event.startDate);
    } else {
      missingFields.startDate++;
    }

    if (event.endDate) {
      endDates.push(event.endDate);
    }

    if (!event.title) missingFields.title++;
    if (!event.presenter) missingFields.presenter++;
    if (!event.venue?.name) missingFields.venue++;

    if (event.id) {
      if (seenIds.has(event.id)) {
        duplicateIds++;
      } else {
        seenIds.add(event.id);
      }
    }
  }

  for (const [clientId, clientConfig] of Object.entries(config.clients)) {
    const clientSummary = {
      clientId,
      either: 0,
      presenterOnly: 0,
      venueOnly: 0,
      both: 0,
      unmatched: 0,
      xmlRows: 0,
    };

    events.forEach((event, index) => {
      const match = getClientMatchDetails(event, clientConfig);
      if (!match.eitherMatch) return;

      matchedEventIndexes.add(index);
      clientSummary.either++;
      clientSummary.xmlRows += countEventXmlRows(event);

      if (match.presenterMatch && match.venueMatch) {
        clientSummary.both++;
      } else if (match.presenterMatch) {
        clientSummary.presenterOnly++;
      } else {
        clientSummary.venueOnly++;
      }
    });

    clientSummary.unmatched = events.length - clientSummary.either;
    clientSummaries.push(clientSummary);
  }

  return {
    matchedAnyClientTotal: matchedEventIndexes.size,
    unmatchedAllClientsTotal: events.length - matchedEventIndexes.size,
    dateRangeStart: startDates.length > 0 ? startDates.reduce((min, value) => (value < min ? value : min)) : "n/a",
    dateRangeEnd: endDates.length > 0 ? endDates.reduce((max, value) => (value > max ? value : max)) : "n/a",
    duplicateIds,
    clientSummaries,
    missingFields,
  };
}

function logVerboseSyncSummary({ trigger, durationMs, syncStats, events }) {
  if (!VERBOSE_SYNC) return;

  const metrics = collectVerboseSyncMetrics(events);

  console.log("[verbose] sync_summary");
  console.log(`  trigger=${trigger} mode=${USE_MOCK ? "mock" : "live"} duration_ms=${durationMs}`);
  console.log(
    `  retrieved_total=${syncStats.retrievedTotal} normalized_total=${events.length} api_requests=${syncStats.apiRequests} pages_fetched=${syncStats.pagesFetched}`
  );
  console.log(
    `  matched_any_client_total=${metrics.matchedAnyClientTotal} unmatched_all_clients_total=${metrics.unmatchedAllClientsTotal}`
  );
  console.log(
    `  date_range_start=${metrics.dateRangeStart} date_range_end=${metrics.dateRangeEnd} duplicate_ids=${metrics.duplicateIds}`
  );

  for (const clientSummary of metrics.clientSummaries) {
    console.log(
      `  client=${clientSummary.clientId} either=${clientSummary.either} presenter_only=${clientSummary.presenterOnly} venue_only=${clientSummary.venueOnly} both=${clientSummary.both} unmatched=${clientSummary.unmatched} xml_rows=${clientSummary.xmlRows}`
    );
  }

  console.log(
    `  missing_fields title=${metrics.missingFields.title} presenter=${metrics.missingFields.presenter} venue=${metrics.missingFields.venue} start_date=${metrics.missingFields.startDate}`
  );
}

function logVerboseSyncFailure({ trigger, durationMs, syncStats, error }) {
  if (!VERBOSE_SYNC) return;

  console.log("[verbose] sync_failed");
  console.log(`  trigger=${trigger} mode=${USE_MOCK ? "mock" : "live"} duration_ms=${durationMs}`);
  console.log(
    `  api_requests=${syncStats.apiRequests} pages_fetched=${syncStats.pagesFetched} retrieved_total_so_far=${syncStats.retrievedTotal}`
  );
  console.log(`  error=${JSON.stringify(error.message)}`);
}

/**
 * Filter cached events for a specific client configuration.
 * An event passes if its presenter OR venue matches the client's allowlists.
 */
function filterEventsForClient(clientId) {
  const clientConfig = config.clients[clientId];
  if (!clientConfig) return null;

  return cache.events.filter((event) => getClientMatchDetails(event, clientConfig).eitherMatch);
}

// ─── XML Serialization ───────────────────────────────────────────────────────

/**
 * Serialize filtered events into XML matching the legacy DMN feed schema.
 * Key behavior: one <event> element per performance datetime.
 */
function eventsToXml(events) {
  const root = create({ version: "1.0", encoding: "UTF-8" }).ele("events");

  for (const event of events) {
    const performances = event.performances.length > 0 ? event.performances : [""];

    for (const performance of performances) {
      const el = root.ele("event").att("ID", event.id);

      el.ele("title").dat(event.title);
      el.ele("image").txt(event.image);
      el.ele("description").dat(event.description);
      el.ele("link").dat(event.link);
      el.ele("location").dat(event.venue.name);
      el.ele("address").dat(event.venue.address);
      el.ele("City").dat(event.venue.city);
      el.ele("State").dat(event.venue.state);
      el.ele("ZipCode").txt(event.venue.zipCode);
      el.ele("presenter").dat(event.presenter);
      el.ele("presenterWebsite").dat(event.presenterWebsite);
      el.ele("startDate").txt(event.startDate);
      el.ele("endDate").txt(event.endDate);
      el.ele("performance").txt(performance);
      el.ele("category").dat(event.category);
      el.ele("ongoing").txt(String(event.ongoing));

      if (event.ticketUrl) {
        el.ele("ticketURL").dat(event.ticketUrl);
      }
      if (event.price) {
        el.ele("price").txt(event.price);
      }
    }
  }

  return root.end({ prettyPrint: true });
}

// ─── Express Server ──────────────────────────────────────────────────────────

const app = express();

// XML feed endpoint
app.get("/feed/:clientId.xml", (req, res) => {
  const { clientId } = req.params;
  const events = filterEventsForClient(clientId);

  if (events === null) {
    return res.status(404).json({
      error: `Unknown client: ${clientId}`,
      available: Object.keys(config.clients),
    });
  }

  console.log(`[${clientId}.xml] Serving ${events.length} events (${cache.events.length} total cached)`);

  const xml = eventsToXml(events);
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.set("X-Total-Events", String(events.length));
  res.set("X-Cache-Time", cache.lastSync || "never");
  res.send(xml);
});

// JSON feed endpoint (useful for debugging and Phase 2 calendar widget)
app.get("/feed/:clientId.json", (req, res) => {
  const { clientId } = req.params;
  const events = filterEventsForClient(clientId);

  if (events === null) {
    return res.status(404).json({
      error: `Unknown client: ${clientId}`,
      available: Object.keys(config.clients),
    });
  }

  console.log(`[${clientId}.json] Serving ${events.length} events`);

  res.json({
    client: clientId,
    label: config.clients[clientId].label,
    totalEvents: events.length,
    lastSync: cache.lastSync,
    events: events.map(({ _raw, ...rest }) => rest), // Strip internal fields
  });
});

// Status / health check
app.get("/status", (req, res) => {
  const clientSummary = {};
  for (const clientId of Object.keys(config.clients)) {
    const filtered = filterEventsForClient(clientId);
    clientSummary[clientId] = {
      label: config.clients[clientId].label,
      matchingEvents: filtered ? filtered.length : 0,
      presenters: config.clients[clientId].presenters.length,
      venues: config.clients[clientId].venues.length,
    };
  }

  res.json({
    status: "ok",
    mode: USE_MOCK ? "mock" : "live",
    cache: {
      totalEvents: cache.events.length,
      lastSync: cache.lastSync,
      lastSyncDuration: cache.lastSyncDuration ? `${cache.lastSyncDuration}ms` : null,
      syncCount: cache.syncCount,
    },
    clients: clientSummary,
    errors: cache.errors.slice(-5),
  });
});

// Manual sync trigger
app.post("/sync", async (req, res) => {
  await syncEvents("manual");
  res.json({ message: "Sync complete", totalEvents: cache.events.length, lastSync: cache.lastSync });
});

// Root — list available endpoints
app.get("/", (req, res) => {
  const clients = Object.entries(config.clients).map(([id, cfg]) => ({
    id,
    label: cfg.label,
    xmlFeed: `/feed/${id}.xml`,
    jsonFeed: `/feed/${id}.json`,
  }));

  res.json({
    name: "Event Calendar Middleware Shim",
    mode: USE_MOCK ? "mock (set API key in config.json for live data)" : "live",
    endpoints: {
      feeds: clients,
      status: "/status",
      manualSync: "POST /sync",
    },
  });
});

// ─── Startup ─────────────────────────────────────────────────────────────────

async function start() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Event Calendar Middleware Shim             ║");
  console.log("║   Ticketmaster → Legacy XML Feed             ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();

  if (USE_MOCK) {
    console.log("⚠  No API key configured — running with MOCK data.");
    console.log("   Set ticketmaster.apiKey in config.json for live data.\n");
  }

  // Initial sync
  await syncEvents("startup");

  // Scheduled sync
  if (config.sync.enabled) {
    const minutes = config.sync.intervalMinutes || 15;
    cron.schedule(`*/${minutes} * * * *`, () => {
      syncEvents("cron");
    });
    console.log(`Scheduled sync every ${minutes} minutes.`);
  }

  app.listen(PORT, () => {
    console.log(`\nServer running at http://localhost:${PORT}`);
    console.log();
    console.log("Available feeds:");
    for (const [id, cfg] of Object.entries(config.clients)) {
      const events = filterEventsForClient(id) || [];
      console.log(`  ${cfg.label}: http://localhost:${PORT}/feed/${id}.xml with ${events.length} events`);
    }
    console.log(`\nStatus: http://localhost:${PORT}/status`);
    console.log();
  });
}

start();
