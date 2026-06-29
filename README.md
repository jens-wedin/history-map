# 🕰️ Wayback — discover history around you

A tiny, dependency-light web app that puts the **history of places on a live map** and surfaces stories **as you walk or drive past them** — no searching, no Googling. Bubbles pop up when you get close; tap one for a summary, or open the full article.

> **Live demo:** once GitHub Pages is enabled (see below), the app is served at
> `https://<your-username>.github.io/history-map/`

## What it does

- 🗺️ Shows a dark, clean map centred on **your location**.
- 📖 Drops a marker on every nearby place that has a story, pulled **live from Wikipedia** (the GeoSearch API — no API key, no backend).
- 📍 **Proximity bubbles:** as you move, the marker for whatever you're closest to lights up and its story opens automatically when you're within ~150 m.
- 🧭 **Follow mode** keeps the map locked to you as you move.
- 🪟 Tap a bubble for a **summary panel** (photo + extract), then **“Read full view”** for the complete article in-app, or open it on Wikipedia.
- 🧪 **Demo mode** simulates a walk through historic Rome so you can try it on a desktop without GPS.

## How it works

Pure static front-end — nothing to deploy but files:

| Piece | Tech |
|------|------|
| Map + tiles | [Leaflet](https://leafletjs.com) + OpenStreetMap / CARTO dark tiles |
| Location | Browser [Geolocation API](https://developer.mozilla.org/docs/Web/API/Geolocation_API) (`watchPosition`) |
| History data | [Wikipedia GeoSearch + REST Summary + Parse APIs](https://www.mediawiki.org/wiki/API:Geosearch) (CORS-enabled, keyless) |

No build step, no framework, no server, no secrets.

## Run locally

Geolocation needs a secure context, so use `http://localhost` (allowed) or HTTPS:

```bash
# any static server works, e.g.
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy on GitHub Pages

This repo ships a GitHub Actions workflow (`.github/workflows/deploy.yml`) that publishes the site automatically.

1. Push to the `main` (or `claude/historic-landmarks-map-txfglb`) branch.
2. In your repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow runs and your site goes live at `https://<username>.github.io/<repo>/`.

> Tip: GitHub Pages is served over HTTPS, which the Geolocation API requires — so location works out of the box.

## Configuration

Tweak the constants at the top of [`js/app.js`](js/app.js):

```js
const CONFIG = {
  proximityMeters: 150,      // how close before a story auto-opens
  searchRadiusMeters: 5000,  // how far around you to search (max 10000)
  maxResults: 80,            // markers per fetch
  refetchMeters: 1200,       // refetch after moving this far
  demoCenter: { lat: 41.8902, lng: 12.4922 }, // Rome
  wikiLang: "en",            // try "de", "fr", "sv", ...
};
```

## Privacy

Your location never leaves your device — it's used only in the browser to query Wikipedia for nearby places and to measure distance. There is no analytics and no backend.

## Credits

History text & images © their authors via **Wikipedia** (CC BY-SA). Map data © **OpenStreetMap** contributors, tiles by **CARTO**.
