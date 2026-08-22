import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;
const TTL_MS = Number(process.env.LOCATION_TTL_MS || 90_000);

app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));

const cache = new Map();

function validMapsLink(link) {
  try {
    const u = new URL(link);
    return [
      "maps.app.goo.gl",
      "www.google.com",
      "google.com",
      "maps.google.com"
    ].includes(u.hostname);
  } catch {
    return false;
  }
}

function extractCoordinates(text) {
  if (!text) return null;

  // Tentativas diferentes porque o Google pode representar
  // coordenadas em formatos diferentes na URL/HTML.
  const patterns = [
    /[?&](?:q|query|ll|center|destination|origin)=(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/i,
    /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,|z|\/|$)/i,
    /!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/i,
    /!1d(-?\d{1,3}(?:\.\d+)?)!2d(-?\d{1,3}(?:\.\d+)?)/i,
    /(?:lat(?:itude)?)[^0-9-]{0,20}(-?\d{1,3}\.\d{4,})[^0-9-]{0,30}(?:lng|lon(?:gitude)?)[^0-9-]{0,20}(-?\d{1,3}\.\d{4,})/i,
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

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

async function inspectWithBrowser(link) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"]
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
      timeout: 25_000
    });

    // Dá tempo para o Maps carregar dados dinamicamente.
    await page.waitForTimeout(4_000);

    const finalUrl = page.url();
    const title = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText().catch(() => "");

    const html = await page.content();

    const candidateTexts = uniqueStrings([
      finalUrl,
      title,
      bodyText,
      html,
      await page.locator('meta[property="og:title"]').getAttribute("content").catch(() => null),
      await page.locator('meta[property="og:description"]').getAttribute("content").catch(() => null),
      await page.locator('meta[property="description"]').getAttribute("content").catch(() => null)
    ]);

    let coordinates = null;
    let matchedFrom = null;

    for (const candidate of candidateTexts) {
      coordinates = extractCoordinates(candidate);
      if (coordinates) {
        matchedFrom = candidate === finalUrl ? "finalUrl" : "page";
        break;
      }
    }

    // Procura também por nomes de rua/endereços visíveis.
    const addressCandidates = await page.locator("body").innerText()
      .then(text => text.split("\n").map(x => x.trim()).filter(Boolean).slice(0, 120))
      .catch(() => []);

    return {
      finalUrl,
      title,
      coordinates,
      matchedFrom,
      visibleTextSample: addressCandidates.slice(0, 60),
      htmlLength: html.length
    };
  } finally {
    await browser.close();
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "rotas-go-location-resolver-v2" });
});

app.post("/api/location/resolve", async (req, res) => {
  const driverId = String(req.body.driverId || "TEST-DRIVER").trim();
  const link = String(req.body.link || "").trim();

  if (!validMapsLink(link)) {
    return res.status(400).json({
      resolved: false,
      error: "LINK_GOOGLE_MAPS_INVALIDO"
    });
  }

  try {
    const result = await inspectWithBrowser(link);

    if (!result.coordinates) {
      return res.status(422).json({
        resolved: false,
        reason: "COORDENADAS_NAO_ENCONTRADAS",
        message:
          "O Google Maps abriu, mas este protótipo não encontrou latitude/longitude no conteúdo renderizado.",
        finalUrl: result.finalUrl,
        title: result.title,
        visibleTextSample: result.visibleTextSample,
        htmlLength: result.htmlLength
      });
    }

    const location = {
      driverId,
      lat: result.coordinates.lat,
      lng: result.coordinates.lng,
      source: "GOOGLE_MAPS_SHARED_LINK_BROWSER_TEST",
      sourceLink: link,
      updatedAt: Date.now(),
      expiresAt: Date.now() + TTL_MS
    };

    cache.set(driverId, location);

    res.json({
      resolved: true,
      lat: location.lat,
      lng: location.lng,
      finalUrl: result.finalUrl,
      matchedFrom: result.matchedFrom,
      location
    });
  } catch (error) {
    console.error(error);

    res.status(502).json({
      resolved: false,
      error: "MAPS_BROWSER_RESOLUTION_FAILED",
      message: error.message
    });
  }
});

app.get("/api/location/:driverId", (req, res) => {
  const location = cache.get(req.params.driverId);

  if (!location) {
    return res.status(404).json({
      found: false,
      message: "Nenhuma localização encontrada."
    });
  }

  if (location.expiresAt <= Date.now()) {
    cache.delete(req.params.driverId);
    return res.status(410).json({
      found: false,
      expired: true
    });
  }

  res.json({
    found: true,
    location
  });
});

app.delete("/api/location/:driverId", (req, res) => {
  cache.delete(req.params.driverId);
  res.json({ ok: true });
});

setInterval(() => {
  const now = Date.now();

  for (const [id, location] of cache) {
    if (location.expiresAt <= now) {
      cache.delete(id);
    }
  }
}, 10_000);

app.listen(PORT, () => {
  console.log(`Rotas GO Location Resolver V2: http://localhost:${PORT}`);
});
