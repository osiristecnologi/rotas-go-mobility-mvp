import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;
const RESOLVE_TIMEOUT_MS = Number(process.env.RESOLVE_TIMEOUT_MS || 18000);
const LOCATION_TTL_MS = Number(process.env.LOCATION_TTL_MS || 90000);

app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));

const locations = new Map();

function json(res, status, payload) {
  return res.status(status).type("application/json").send(JSON.stringify(payload));
}

function googleLink(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      (
        u.hostname === "maps.app.goo.gl" ||
        u.hostname === "goo.gl" ||
        u.hostname === "google.com" ||
        u.hostname.endsWith(".google.com")
      )
    );
  } catch {
    return false;
  }
}

function extractCoordinates(value) {
  const text = String(value ?? "");

  const patterns = [
    /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/,
    /[?&](?:q|query|ll|center|destination|origin)=(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/i,
    /!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/,
    /(-?\d{1,3}\.\d{5,})\s*[,;]\s*(-?\d{1,3}\.\d{5,})/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const lat = Number(match[1]);
    const lng = Number(match[2]);

    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      return { lat, lng };
    }
  }

  return null;
}

async function withTimeout(promise, ms) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`RESOLVE_TIMEOUT_${ms}MS`)),
      ms
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function inspectGoogleLink(link) {
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      timeout: 10000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--disable-blink-features=AutomationControlled"
      ]
    });

    const context = await browser.newContext({
      locale: "pt-BR",
      viewport: { width: 390, height: 844 },
      userAgent:
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36"
    });

    const page = await context.newPage();

    await page.goto(link, {
      waitUntil: "domcontentloaded",
      timeout: 12000
    });

    await page.waitForTimeout(2500);

    const finalUrl = page.url();
    const title = await page.title().catch(() => "");
    const visibleText = await page.locator("body").innerText().catch(() => "");
    const html = await page.content().catch(() => "");

    const candidates = [
      { source: "final_url", value: finalUrl },
      { source: "title", value: title },
      { source: "visible_text", value: visibleText },
      { source: "html", value: html }
    ];

    for (const candidate of candidates) {
      const coordinates = extractCoordinates(candidate.value);

      if (coordinates) {
        return {
          resolved: true,
          coordinates,
          matchedFrom: candidate.source,
          finalUrl,
          title,
          htmlLength: html.length
        };
      }
    }

    return {
      resolved: false,
      finalUrl,
      title,
      htmlLength: html.length,
      visibleTextSample: visibleText
        .split("\n")
        .map(x => x.trim())
        .filter(Boolean)
        .slice(0, 50)
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "rotas-go-location-resolver",
    version: "4.0",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get("/api/version", (_req, res) => {
  res.json({
    ok: true,
    version: "4.0",
    resolver: "playwright-safe-resolver"
  });
});

app.post("/api/location/resolve", async (req, res) => {
  const startedAt = Date.now();
  const driverId = String(req.body?.driverId || "TEST-DRIVER").trim();
  const link = String(req.body?.link || "").trim();

  if (!googleLink(link)) {
    return json(res, 400, {
      ok: false,
      resolved: false,
      stage: "validation",
      error: "LINK_GOOGLE_MAPS_INVALIDO"
    });
  }

  try {
    const result = await withTimeout(
      inspectGoogleLink(link),
      RESOLVE_TIMEOUT_MS
    );

    const durationMs = Date.now() - startedAt;

    if (!result.resolved) {
      return json(res, 422, {
        ok: true,
        resolved: false,
        stage: "coordinate-extraction",
        reason: "COORDENADAS_NAO_ENCONTRADAS",
        durationMs,
        finalUrl: result.finalUrl ?? null,
        title: result.title ?? null,
        htmlLength: result.htmlLength ?? null,
        visibleTextSample: result.visibleTextSample ?? []
      });
    }

    const now = Date.now();

    const location = {
      driverId,
      lat: result.coordinates.lat,
      lng: result.coordinates.lng,
      source: "GOOGLE_MAPS_SHARED_LINK_TEST",
      updatedAt: now,
      expiresAt: now + LOCATION_TTL_MS
    };

    locations.set(driverId, location);

    return json(res, 200, {
      ok: true,
      resolved: true,
      stage: "complete",
      durationMs,
      location,
      finalUrl: result.finalUrl,
      matchedFrom: result.matchedFrom
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;

    console.error("[RESOLVE]", {
      driverId,
      durationMs,
      error: error?.stack || error?.message || String(error)
    });

    return json(res, 502, {
      ok: false,
      resolved: false,
      stage: "browser",
      error: error?.message || String(error),
      durationMs
    });
  }
});

app.get("/api/location/:driverId", (req, res) => {
  const driverId = req.params.driverId;
  const location = locations.get(driverId);

  if (!location) {
    return json(res, 404, {
      ok: true,
      found: false,
      expired: false
    });
  }

  if (location.expiresAt <= Date.now()) {
    locations.delete(driverId);

    return json(res, 410, {
      ok: true,
      found: false,
      expired: true
    });
  }

  return res.json({
    ok: true,
    found: true,
    location
  });
});

setInterval(() => {
  const now = Date.now();

  for (const [driverId, location] of locations) {
    if (location.expiresAt <= now) {
      locations.delete(driverId);
    }
  }
}, 10000);

app.listen(PORT, () => {
  console.log(`[Rotas GO] V4 running on port ${PORT}`);
});
