# Event Calendar Middleware Shim
test-kg
Middleware service that fetches events from Ticketmaster (designed to be swapped for Evvnt), filters by presenter/venue allowlists, and serves XML matching the legacy DMN feed schema used by AT&T PAC's Culture Calendar.

## Quick Start

```bash
npm install
npm start
npm start -- --verbose
```

The server starts on `http://localhost:3000` with **mock data** by default (no API key needed to test).
Use `-v` or `--verbose` to print sync-volume metrics after startup, scheduled, and manual syncs.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /feed/attpac.xml` | Filtered XML feed for AT&T PAC |
| `GET /feed/attpac.json` | Same data as JSON (for debugging) |
| `GET /feed/oac_dallas.xml` | Filtered XML feed for OAC Dallas |
| `GET /feed/oac_dallas.json` | Same data as JSON |
| `GET /status` | Cache status, sync info, per-client event counts |
| `POST /sync` | Trigger a manual re-sync from the API |
| `GET /` | List all available endpoints |

## Configuration

Edit `config.json` to:

- **Add your Ticketmaster API key** — register free at [developer.ticketmaster.com](https://developer.ticketmaster.com/products-and-docs/apis/getting-started/)
- **Edit presenter/venue allowlists** per client
- **Add new clients** — just add a new key under `"clients"` and a feed endpoint is automatically created
- **Adjust sync interval** — default is every 15 minutes

## How Filtering Works

The shim uses an OR-based match: an event is included if its **presenter matches** any name in the client's presenter list **OR** its **venue matches** any name in the venue list. Matching is case-insensitive and supports partial/substring matches to handle variations (e.g., "Meyerson Symphony Center" matches "Morton H. Meyerson Symphony Center").

## XML Output Schema

The XML output matches the legacy DMN feed exactly. Key behavior: **one `<event>` element per performance time**. A show with 3 performances becomes 3 XML elements sharing the same ID.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<events>
  <event ID="mock-001">
    <title><![CDATA[The Music Man]]></title>
    <image>https://...</image>
    <description><![CDATA[...]]></description>
    <link><![CDATA[https://...]]></link>
    <location><![CDATA[Winspear Opera House]]></location>
    <address><![CDATA[2403 Flora St.]]></address>
    <City><![CDATA[Dallas]]></City>
    <State><![CDATA[TX]]></State>
    <ZipCode>75201</ZipCode>
    <presenter><![CDATA[AT&T Performing Arts Center]]></presenter>
    <presenterWebsite><![CDATA[https://www.attpac.org/]]></presenterWebsite>
    <startDate>2026-03-13</startDate>
    <endDate>2026-03-15</endDate>
    <performance>2026-03-13 19:30:00</performance>
    <category><![CDATA[Musical Theater]]></category>
    <ongoing>true</ongoing>
    <ticketURL><![CDATA[https://...]]></ticketURL>
    <price>89</price>
  </event>
</events>
```

## Swapping to Evvnt

When Evvnt credentials are available:

1. Add a `normalizeEvvntEvent()` function in `server.js` that maps Evvnt's JSON fields to the internal format (see the field mapping in the tech spec PDF)
2. Replace the `fetchAllEvents()` call with Evvnt API pagination using HTTP Basic Auth
3. Use the `/v3/events?include=occurrences` endpoint to get performance times
4. Update `config.json` with Evvnt credentials

The filtering, caching, XML serialization, and Express endpoints remain unchanged.

## Project Structure

```
evvnt-shim/
├── config.json    # API keys, sync settings, client filter lists
├── server.js      # Main application (fetch, filter, serialize, serve)
├── package.json   # Dependencies
└── README.md      # This file
```

test ms
