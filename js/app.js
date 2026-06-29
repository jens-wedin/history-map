/* Wayback — discover history around you as you move.
 * Static, no backend. Data comes live from Wikipedia's public APIs.
 */
(function () {
  "use strict";

  // ----- Config -----
  const CONFIG = {
    proximityMeters: 150,      // auto-open a story when this close
    midMeters: 250,            // within this range = full pin; beyond it = small dot
    searchRadiusMeters: 5000,  // how far around you to look for places (Wikipedia max 10000)
    maxResults: 80,            // cap markers per fetch
    refetchMeters: 1200,       // refetch places after moving this far
    demoCenter: { lat: 41.8902, lng: 12.4922 }, // Colosseum, Rome
    wikiLang: "en",
  };

  // ----- State -----
  const state = {
    map: null,
    userMarker: null,
    userAccuracyCircle: null,
    markers: new Map(),        // pageid -> { marker, data, announced }
    lastFetchPos: null,
    follow: false,
    activeId: null,
  };

  // ----- DOM -----
  const $ = (id) => document.getElementById(id);
  const el = {
    intro: $("intro"),
    startBtn: $("startBtn"),
    demoBtn: $("demoBtn"),
    status: $("status"),
    locateBtn: $("locateBtn"),
    followBtn: $("followBtn"),
    panel: $("panel"),
    panelClose: $("panelClose"),
    panelImageWrap: $("panelImageWrap"),
    panelTitle: $("panelTitle"),
    panelDistance: $("panelDistance"),
    panelExtract: $("panelExtract"),
    panelFull: $("panelFull"),
    panelWiki: $("panelWiki"),
    fullview: $("fullview"),
    fullClose: $("fullClose"),
    fullTitle: $("fullTitle"),
    fullWiki: $("fullWiki"),
    fullContent: $("fullContent"),
  };

  let statusTimer = null;
  function status(msg, persist) {
    el.status.textContent = msg;
    el.status.classList.add("show");
    clearTimeout(statusTimer);
    if (!persist) {
      statusTimer = setTimeout(() => el.status.classList.remove("show"), 3500);
    }
  }

  // ----- Geometry: haversine distance in meters -----
  function distanceMeters(a, b) {
    const R = 6371000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const la1 = (a.lat * Math.PI) / 180;
    const la2 = (b.lat * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function formatDistance(m) {
    if (m < 1000) return Math.round(m) + " m away";
    return (m / 1000).toFixed(1) + " km away";
  }

  // ----- Map setup -----
  const TILE_ATTR =
    '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · History via <a href="https://wikipedia.org">Wikipedia</a>';

  function prefersLight() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  }

  function tileUrl(light) {
    const style = light ? "light_all" : "dark_all";
    return `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`;
  }

  // Keep map tiles and the browser chrome colour in sync with the OS theme.
  function applyTheme() {
    const light = prefersLight();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", light ? "#f6f4ef" : "#1b2a4a");
    if (state.tileLayer) state.tileLayer.setUrl(tileUrl(light));
  }

  function initMap(center) {
    state.map = L.map("map", { zoomControl: false, attributionControl: true }).setView(
      [center.lat, center.lng],
      16
    );
    L.control.zoom({ position: "bottomright" }).addTo(state.map);

    state.tileLayer = L.tileLayer(tileUrl(prefersLight()), {
      attribution: TILE_ATTR,
      subdomains: "abcd",
      maxZoom: 20,
    }).addTo(state.map);

    applyTheme();
  }

  // React to the user flipping their OS between light and dark.
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  }

  function setUserPosition(pos) {
    const latlng = [pos.lat, pos.lng];
    if (!state.userMarker) {
      const icon = L.divIcon({ className: "", html: '<div class="user-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
      state.userMarker = L.marker(latlng, { icon, zIndexOffset: 1000, interactive: false }).addTo(state.map);
    } else {
      state.userMarker.setLatLng(latlng);
    }
    if (state.follow) state.map.panTo(latlng, { animate: true });
  }

  // ----- Wikipedia data -----
  function wikiApi(lang) {
    return `https://${lang}.wikipedia.org/w/api.php`;
  }

  async function fetchNearbyPlaces(pos) {
    const params = new URLSearchParams({
      action: "query",
      list: "geosearch",
      gscoord: `${pos.lat}|${pos.lng}`,
      gsradius: String(CONFIG.searchRadiusMeters),
      gslimit: String(CONFIG.maxResults),
      format: "json",
      origin: "*",
    });
    const url = `${wikiApi(CONFIG.wikiLang)}?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("geosearch failed");
    const json = await res.json();
    return (json.query && json.query.geosearch) || [];
  }

  // Get summary (extract + thumbnail) for a page title.
  async function fetchSummary(title) {
    const url = `https://${CONFIG.wikiLang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      title
    )}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("summary failed");
    return res.json();
  }

  // Full HTML article body for the reading view.
  async function fetchFullHtml(title) {
    const params = new URLSearchParams({
      action: "parse",
      page: title,
      prop: "text",
      format: "json",
      formatversion: "2",
      redirects: "1",
      origin: "*",
    });
    const res = await fetch(`${wikiApi(CONFIG.wikiLang)}?${params}`);
    if (!res.ok) throw new Error("parse failed");
    const json = await res.json();
    return (json.parse && json.parse.text) || "";
  }

  // ----- Place types -> icon -----
  // Wikipedia GeoSearch only gives title + coords, so we classify each place
  // from its short description (e.g. "Catholic church in Rome"). First match wins,
  // so rules are ordered most-specific first.
  const TYPE_RULES = [
    [/cathedral|basilica|minster/, "⛪", "Cathedral"],
    [/church|chapel|abbey|monaster|convent|priory|friary|parish/, "⛪", "Church"],
    [/mosque/, "🕌", "Mosque"],
    [/synagogue/, "🕍", "Synagogue"],
    [/amphitheat|\bforum\b|ancient roman|roman temple|greek temple|ancient greek/, "🏛️", "Ancient site"],
    [/temple|shrine/, "🛕", "Temple"],
    [/archaeolog|\bruins?\b|excavation/, "🏺", "Ruins"],
    [/palace|château|chateau|stately home/, "🏰", "Palace"],
    [/castle|fortress|\bfort\b|citadel|city wall|bastion/, "🏰", "Castle"],
    [/museum|gallery/, "🖼️", "Museum"],
    [/theat(re|er)|opera|playhouse|concert hall|cinema/, "🎭", "Theatre"],
    [/library/, "📚", "Library"],
    [/universit|college|\bschool\b|academy|institute/, "🎓", "University"],
    [/town hall|city hall|guildhall|hôtel de ville|courthouse|parliament|capitol/, "🏛️", "Civic building"],
    [/monument|memorial|obelisk|statue|sculpture|\bcolumn\b|cenotaph/, "🗿", "Monument"],
    [/fountain/, "⛲", "Fountain"],
    [/bridge|viaduct|aqueduct/, "🌉", "Bridge"],
    [/tower|lighthouse/, "🗼", "Tower"],
    [/park|garden|arboretum|botanical/, "🌳", "Park"],
    [/cemetery|graveyard|\btomb\b|mausoleum|necropolis|catacomb|burial/, "⚰️", "Cemetery"],
    [/station|railway/, "🚉", "Station"],
    [/stadium|arena/, "🏟️", "Stadium"],
    [/market|bazaar/, "🛍️", "Market"],
    [/hotel|\binn\b/, "🏨", "Hotel"],
    [/hospital|infirmary|asylum/, "🏥", "Hospital"],
    [/mountain|\bhill\b|\bmount\b|\bpeak\b|volcano/, "⛰️", "Natural feature"],
    [/lake|\briver\b|canal|waterfall|reservoir|\bpond\b/, "💧", "Waterway"],
    [/square|piazza|plaza|\bsteps\b/, "🏙️", "Square"],
    [/house|villa|residence|mansion|cottage|birthplace|manor/, "🏠", "House"],
  ];

  function classifyType(title, description) {
    const hay = `${title} ${description || ""}`.toLowerCase();
    for (const [re, emoji, label] of TYPE_RULES) {
      if (re.test(hay)) return { emoji, label };
    }
    return { emoji: "📖", label: "" };
  }

  // Batch-fetch short descriptions for a set of page ids (max 50 per request).
  async function fetchDescriptions(pageids) {
    const out = new Map();
    for (let i = 0; i < pageids.length; i += 50) {
      const chunk = pageids.slice(i, i + 50);
      const params = new URLSearchParams({
        action: "query",
        prop: "description",
        pageids: chunk.join("|"),
        format: "json",
        formatversion: "2",
        origin: "*",
      });
      try {
        const res = await fetch(`${wikiApi(CONFIG.wikiLang)}?${params}`);
        if (!res.ok) continue;
        const json = await res.json();
        ((json.query && json.query.pages) || []).forEach((p) => out.set(p.pageid, p.description || ""));
      } catch (e) {
        /* keep default icons on failure */
      }
    }
    return out;
  }

  // Classify markers by type and swap in the matching icon.
  async function enrichTypes(places) {
    const ids = places.map((p) => p.pageid).filter((id) => state.markers.has(id));
    if (!ids.length) return;
    const descs = await fetchDescriptions(ids);
    descs.forEach((desc, pageid) => {
      const entry = state.markers.get(pageid);
      if (!entry) return;
      const t = classifyType(entry.data.title, desc);
      entry.data.emoji = t.emoji;
      entry.data.typeLabel = t.label;
      entry.marker.setIcon(makeIcon(t.emoji, entry.tier));
    });
  }

  // ----- Markers -----
  // Size depends on how far the place is from the user:
  //   near (very close) -> pulsing pin · mid -> full pin · far -> small dot.
  function tierForDistance(d) {
    if (d == null) return "mid";
    if (d <= CONFIG.proximityMeters) return "near";
    if (d <= CONFIG.midMeters) return "mid";
    return "far";
  }

  function makeIcon(emoji, tier) {
    if (tier === "far") {
      // A small dot, but the 24px transparent box keeps a comfortable tap target.
      return L.divIcon({
        className: "",
        html: '<div class="hm-dot"><span class="hm-dot-core"></span></div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        popupAnchor: [0, -10],
      });
    }
    return L.divIcon({
      className: "",
      html: `<div class="hm-marker${tier === "near" ? " near" : ""}"><span>${emoji || "📖"}</span></div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
      popupAnchor: [0, -28],
    });
  }

  function addMarker(place) {
    if (state.markers.has(place.pageid)) return;
    const data = { pageid: place.pageid, title: place.title, lat: place.lat, lng: place.lon, emoji: "📖", typeLabel: "" };
    const marker = L.marker([place.lat, place.lon], { icon: makeIcon(data.emoji, "mid") }).addTo(state.map);
    marker.on("click", () => openPanel(place.pageid));
    state.markers.set(place.pageid, { marker, data, announced: false, tier: "mid" });
  }

  async function loadPlaces(pos) {
    try {
      status("Looking for history nearby…", true);
      const places = await fetchNearbyPlaces(pos);
      places.forEach(addMarker);
      enrichTypes(places); // classify icons in the background; markers show immediately
      checkProximity(pos); // size new markers (dot vs pin) right away
      state.lastFetchPos = pos;
      if (state.markers.size === 0) {
        status("No mapped history within " + CONFIG.searchRadiusMeters / 1000 + " km here.");
      } else {
        status(`Found ${state.markers.size} place${state.markers.size === 1 ? "" : "s"} with stories around you.`);
      }
    } catch (e) {
      console.error(e);
      status("Couldn't reach Wikipedia. Check your connection.");
    }
  }

  // ----- Proximity check on each position update -----
  function checkProximity(pos) {
    let nearest = null;
    let nearestDist = Infinity;
    state.markers.forEach((entry) => {
      const d = distanceMeters(pos, entry.data);
      const tier = tierForDistance(d);
      if (tier !== entry.tier) {
        entry.tier = tier;
        entry.marker.setIcon(makeIcon(entry.data.emoji, tier));
      }
      if (tier === "near" && d < nearestDist) {
        nearestDist = d;
        nearest = entry;
      }
    });

    // Auto-announce the nearest unseen place by opening its bubble.
    if (nearest && !nearest.announced && state.activeId === null) {
      nearest.announced = true;
      openPanel(nearest.data.pageid, nearestDist);
      if (navigator.vibrate) navigator.vibrate(60);
    }
  }

  // ----- Panel (detail) -----
  async function openPanel(pageid, knownDist) {
    const entry = state.markers.get(pageid);
    if (!entry) return;
    state.activeId = pageid;
    const { data } = entry;

    el.panelTitle.textContent = data.title;
    el.panelExtract.textContent = "";
    el.panelImageWrap.className = "panel-image-wrap empty";
    el.panelImageWrap.innerHTML = '<div class="spinner"></div>';

    const dist = knownDist != null ? knownDist : (state.userMarker ? distanceMeters(getUserPos(), data) : null);
    const distParts = [];
    if (data.typeLabel) distParts.push(`${data.emoji} ${data.typeLabel}`);
    if (dist != null) distParts.push(formatDistance(dist));
    el.panelDistance.textContent = distParts.join(" · ");

    const wikiUrl = `https://${CONFIG.wikiLang}.wikipedia.org/?curid=${pageid}`;
    el.panelWiki.href = wikiUrl;

    el.panel.classList.add("open");
    el.panel.setAttribute("aria-hidden", "false");

    try {
      const summary = await fetchSummary(data.title);
      el.panelExtract.textContent = summary.extract || "No summary available for this place.";
      if (summary.thumbnail && summary.thumbnail.source) {
        el.panelImageWrap.className = "panel-image-wrap";
        el.panelImageWrap.innerHTML = `<img src="${summary.thumbnail.source}" alt="${escapeHtml(data.title)}" />`;
      } else {
        el.panelImageWrap.className = "panel-image-wrap empty";
        el.panelImageWrap.innerHTML = "🏛️";
      }
      if (summary.content_urls && summary.content_urls.desktop) {
        el.panelWiki.href = summary.content_urls.desktop.page;
      }
    } catch (e) {
      el.panelExtract.textContent = "Couldn't load the story right now.";
      el.panelImageWrap.className = "panel-image-wrap empty";
      el.panelImageWrap.innerHTML = "🏛️";
    }

    el.panelFull.onclick = () => openFullView(data.title, el.panelWiki.href);
  }

  function closePanel() {
    el.panel.classList.remove("open");
    el.panel.setAttribute("aria-hidden", "true");
    state.activeId = null;
  }

  // ----- Full reading view -----
  async function openFullView(title, wikiUrl) {
    el.fullTitle.textContent = title;
    el.fullWiki.href = wikiUrl;
    el.fullContent.innerHTML = '<div class="spinner"></div>';
    el.fullview.classList.add("open");
    el.fullview.setAttribute("aria-hidden", "false");
    try {
      const html = await fetchFullHtml(title);
      el.fullContent.innerHTML = sanitizeArticle(html);
    } catch (e) {
      el.fullContent.innerHTML = "<p>Couldn't load the full article. Try opening it on Wikipedia.</p>";
    }
    el.fullContent.scrollTop = 0;
  }

  function closeFullView() {
    el.fullview.classList.remove("open");
    el.fullview.setAttribute("aria-hidden", "true");
  }

  // Strip edit links, references clutter, scripts; rewrite relative links.
  function sanitizeArticle(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll(
      "script, style, .mw-editsection, .reference, .noprint, .navbox, .vertical-navbox, .infobox .navbar, sup.reference, table.ambox, .hatnote, .metadata, #toc, .mw-jump-link"
    ).forEach((n) => n.remove());

    // Resolve protocol-relative and relative URLs to absolute Wikipedia ones.
    const base = `https://${CONFIG.wikiLang}.wikipedia.org`;
    doc.querySelectorAll("a[href]").forEach((a) => {
      let href = a.getAttribute("href");
      if (href.startsWith("//")) href = "https:" + href;
      else if (href.startsWith("/")) href = base + href;
      a.setAttribute("href", href);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    });
    doc.querySelectorAll("img[src]").forEach((img) => {
      let src = img.getAttribute("src");
      if (src.startsWith("//")) img.setAttribute("src", "https:" + src);
    });
    return doc.body.innerHTML;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ----- Geolocation -----
  let watchId = null;
  let lastUserPos = null;
  function getUserPos() { return lastUserPos; }

  function startTracking() {
    if (!("geolocation" in navigator)) {
      status("Geolocation isn't supported on this device.");
      return;
    }
    status("Getting your location…", true);
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        const first = !lastUserPos;
        lastUserPos = pos;
        setUserPosition(pos);
        if (first) {
          state.map.setView([pos.lat, pos.lng], 16);
          loadPlaces(pos);
        } else if (!state.lastFetchPos || distanceMeters(pos, state.lastFetchPos) > CONFIG.refetchMeters) {
          loadPlaces(pos);
        }
        checkProximity(pos);
      },
      (err) => {
        console.warn(err);
        if (err.code === err.PERMISSION_DENIED) {
          status("Location blocked. Showing the demo instead.");
          startDemo();
        } else {
          status("Couldn't get your location. Try the demo.");
        }
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  }

  // ----- Demo mode (no GPS): walk the simulated visitor past real monuments -----
  let demoTimer = null;
  function startDemo() {
    hideIntro();
    const c = CONFIG.demoCenter;
    if (!state.map) initMap(c);
    state.map.setView([c.lat, c.lng], 16);
    lastUserPos = { ...c };
    setUserPosition(lastUserPos);
    loadPlaces(c).then(() => {
      status("Demo: strolling through historic Rome. Stories open as you reach each place.");
      // Build a walking route from the actual nearby markers (nearest-first),
      // so the visitor reliably passes within range of each and bubbles trigger.
      const route = Array.from(state.markers.values())
        .map((e) => e.data)
        .sort((a, b) => distanceMeters(c, a) - distanceMeters(c, b))
        .slice(0, 12);
      if (route.length === 0) return;

      const stepMeters = 35; // walker advances ~35 m per tick
      let target = 0;
      clearInterval(demoTimer);
      demoTimer = setInterval(() => {
        const dest = route[target % route.length];
        const here = lastUserPos;
        const d = distanceMeters(here, dest);
        let next;
        if (d <= stepMeters) {
          next = { lat: dest.lat, lng: dest.lng };
          target++; // arrived — head for the next place
        } else {
          const f = stepMeters / d; // step a fraction of the way toward dest
          next = {
            lat: here.lat + (dest.lat - here.lat) * f,
            lng: here.lng + (dest.lng - here.lng) * f,
          };
        }
        lastUserPos = next;
        setUserPosition(next);
        checkProximity(next);
      }, 1200);
    });
  }

  // ----- Intro -----
  function hideIntro() {
    el.intro.classList.add("hide");
    el.intro.setAttribute("aria-hidden", "true");
  }

  function startReal() {
    hideIntro();
    initMap(CONFIG.demoCenter); // temporary center until GPS arrives
    startTracking();
  }

  // ----- Wire up UI -----
  el.startBtn.addEventListener("click", startReal);
  el.demoBtn.addEventListener("click", startDemo);
  el.panelClose.addEventListener("click", closePanel);
  el.fullClose.addEventListener("click", closeFullView);
  el.locateBtn.addEventListener("click", () => {
    if (lastUserPos) state.map.setView([lastUserPos.lat, lastUserPos.lng], 16, { animate: true });
  });
  el.followBtn.addEventListener("click", () => {
    state.follow = !state.follow;
    el.followBtn.classList.toggle("active", state.follow);
    status(state.follow ? "Follow mode on — the map tracks you." : "Follow mode off.");
    if (state.follow && lastUserPos) state.map.panTo([lastUserPos.lat, lastUserPos.lng]);
  });

  // Close panels with Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (el.fullview.classList.contains("open")) closeFullView();
      else if (el.panel.classList.contains("open")) closePanel();
    }
  });
})();
