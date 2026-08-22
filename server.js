import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;
const TTL_MS = Number(process.env.LOCATION_TTL_MS || 90_000);

app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));

const cache = new Map();

function isGoogleMapsLink(value) {
  try {
    const u = new URL(value);
    return /(^|\.)google\.com$|(^|\.)maps\.app\.goo\.gl$/.test(u.hostname);
  } catch {
    return false;
  }
}

function extractCoordinates(text) {
  if (!text) return null;

  const patterns = [
    /[?&](?:q|query|ll|center|destination|origin)=(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/i,
    /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/i,
    /!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/i,
    /!1d(-?\d{1,3}(?:\.\d+)?)!2d(-?\d{1,3}(?:\.\d+)?)/i,
    /(-?\d{1,3}\.\d{5,})\s*[,;]\s*(-?\d{1,3}\.\d{5,})/
  ];

  for (const re of patterns) {
    const m = String(text).match(re);
    if (!m) continue;

    const lat = Number(m[1]);
    const lng = Number(m[2]);

    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      return { lat, lng, pattern: re.toString() };
    }
  }

  return null;
}

async function inspect(link) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  try {
    const context = await browser.newContext({
      locale: "pt-BR",
      userAgent:
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36"
    });

    const page = await context.newPage();

    await page.goto(link, {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });

    await page.waitForTimeout(6_000);

    const finalUrl = page.url();
    const title = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const html = await page.content();

    const candidates = [finalUrl, title, bodyText, html];

    let coordinates = null;
    let matchedFrom = null;

    for (const candidate of candidates) {
      const found = extractCoordinates(candidate);
      if (found) {
        coordinates = found;
        matchedFrom =
          candidate === finalUrl ? "final_url" :
          candidate === title ? "title" :
          candidate === bodyText ? "visible_text" : "html";
        break;
      }
    }

    return {
      finalUrl,
      title,
      coordinates,
      matchedFrom,
      htmlLength: html.length,
      visibleTextSample: bodyText
        .split("\n")
        .map(x => x.trim())
        .filter(Boolean)
        .slice(0, 80)
    };
  } finally {
    await browser.close();
  }
}

app.get("/api/version", (_req, res) => {
  res.json({
    ok: true,
    version: "3.0",
    resolver: "playwright-google-maps",
    timestamp: new Date().toISOString()
  });
});

app.post("/api/location/resolve", async (req, res) => {
  const driverId = String(req.body?.driverId || "TEST-DRIVER").trim();
  const link = String(req.body?.link || "").trim();

  if (!isGoogleMapsLink(link)) {
    return res.status(400).json({
      ok: false,
      resolved: false,
      error: "LINK_GOOGLE_MAPS_INVALIDO"
    });
  }

  try {
    const inspected = await inspect(link);

    if (!inspected.coordinates) {
      return res.status(422).json({
        ok: true,
        resolved: false,
        reason: "COORDENADAS_NAO_ENCONTRADAS",
        finalUrl: inspected.finalUrl,
        title: inspected.title,
        htmlLength: inspected.htmlLength,
        matchedFrom: inspected.matchedFrom,
        visibleTextSample: inspected.visibleTextSample
      });
    }

    const now = Date.now();

    const location = {
      driverId,
      lat: inspected.coordinates.lat,
      lng: inspected.coordinates.lng,
      source: "GOOGLE_MAPS_SHARED_LINK_TEST",
      updatedAt: now,
      expiresAt: now + TTL_MS
    };

    cache.set(driverId, location);

    return res.json({
      ok: true,
      resolved: true,
      driverId,
      lat: location.lat,
      lng: location.lng,
      source: location.source,
      updatedAt: location.updatedAt,
      expiresAt: location.expiresAt,
      finalUrl: inspected.finalUrl,
      matchedFrom: inspected.matchedFrom
    });
  } catch (error) {
    console.error("RESOLVER_ERROR", error);

    return res.status(502).json({
      ok: false,
      resolved: false,
      error: "MAPS_BROWSER_RESOLUTION_FAILED",
      message: error?.message || String(error)
    });
  }
});

app.get("/api/location/:driverId", (req, res) => {
  const location = cache.get(req.params.driverId);

  if (!location) {
    return res.status(404).json({
      ok: true,
      found: false,
      expired: false
    });
  }

  if (location.expiresAt <= Date.now()) {
    cache.delete(req.params.driverId);
    return res.status(410).json({
      ok: true,
      found: false,
      expired: true
    });
  }

  res.json({
    ok: true,
    found: true,
    location
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, location] of cache) {
    if (location.expiresAt <= now) cache.delete(id);
  }
}, 10_000);

app.listen(PORT, () => {
  console.log(`Rotas GO Resolver V3 running on port ${PORT}`);
});
