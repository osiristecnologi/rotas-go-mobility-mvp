import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 3000;
const RESOLVE_TIMEOUT_MS = Number(process.env.RESOLVE_TIMEOUT_MS || 22000);
const LOCATION_TTL_MS = Number(process.env.LOCATION_TTL_MS || 90000);
const PLAYWRIGHT_ENABLED = process.env.PLAYWRIGHT_ENABLED !== "0";

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
        u.hostname === "maps.google.com" ||
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
    // URL path style: /@-23.5505,-46.6333,17z
    /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/,
    // query params
    /[?&](?:q|query|ll|center|destination|origin|daddr|saddr)=(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/i,
    // Google internal: !3dLAT!4dLNG
    /!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/,
    // data=!3d... or similar
    /data=.*?(-?\d{1,3}\.\d{4,}),(-?\d{1,3}\.\d{4,})/,
    // plain text pairs with enough decimals
    /(-?\d{1,2}\.\d{5,})\s*[,;]\s*(-?\d{1,3}\.\d{5,})/,
    // JSON-ish
    /"lat(?:itude)?"\s*:\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*"lng(?:itude)?"\s*:\s*(-?\d{1,3}(?:\.\d+)?)/i,
    /"latitude"\s*:\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*"longitude"\s*:\s*(-?\d{1,3}(?:\.\d+)?)/i,
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
      Math.abs(lng) <= 180 &&
      // discard obvious defaults / zeros
      !(Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01)
    ) {
      return { lat, lng };
    }
  }

  return null;
}

async function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`TIMEOUT_${label}_${ms}MS`)),
      ms
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lightweight expansion of short links (no browser).
 * Handles maps.app.goo.gl → final google.com/maps URL.
 * Also parses browser_fallback_url from intent:// redirects.
 */
async function expandShortLink(link) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    // First request – may return 302 to intent:// or to maps
    const res1 = await fetch(link, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });

    let finalUrl = res1.headers.get("location") || link;
    let status = res1.status;

    // Handle Android intent:// with browser_fallback_url
    if (finalUrl.startsWith("intent://") || finalUrl.includes("browser_fallback_url=")) {
      const fallbackMatch = finalUrl.match(
        /browser_fallback_url=([^;]+)/i
      );
      if (fallbackMatch) {
        finalUrl = decodeURIComponent(fallbackMatch[1]);
      }
    }

    // Follow one more redirect if needed
    if (status >= 300 && status < 400 && finalUrl.startsWith("http")) {
      const res2 = await fetch(finalUrl, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
      finalUrl = res2.url || finalUrl;
      status = res2.status;

      // Try to get a small piece of body for extra patterns (optional, limited)
      const text = await res2.text().catch(() => "");
      return {
        ok: true,
        finalUrl,
        status,
        bodySample: text.slice(0, 12000),
        method: "fetch-expand",
      };
    }

    // If no redirect body was fetched, try a full follow from original
    const resFull = await fetch(link, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });

    const text = await resFull.text().catch(() => "");
    return {
      ok: true,
      finalUrl: resFull.url || finalUrl,
      status: resFull.status,
      bodySample: text.slice(0, 12000),
      method: "fetch-expand",
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      method: "fetch-expand",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function inspectWithPlaywright(link) {
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      timeout: 12000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    });

    const context = await browser.newContext({
      locale: "pt-BR",
      viewport: { width: 390, height: 844 },
      userAgent:
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
    });

    // Collect interesting network responses (possible location payloads)
    const networkSnippets = [];
    context.on("response", async (response) => {
      try {
        const url = response.url();
        const ct = (response.headers()["content-type"] || "").toLowerCase();
        if (
          (ct.includes("json") || ct.includes("javascript") || url.includes("maps")) &&
          response.status() === 200 &&
          networkSnippets.length < 8
        ) {
          const body = await response.text().catch(() => "");
          if (body && body.length < 50000) {
            const coords = extractCoordinates(body);
            if (coords) {
              networkSnippets.push({
                url: url.slice(0, 180),
                coords,
              });
            }
          }
        }
      } catch {
        // ignore individual response errors
      }
    });

    const page = await context.newPage();

    await page.goto(link, {
      waitUntil: "domcontentloaded",
      timeout: 14000,
    });

    // Give Maps time to hydrate / redirect
    await page.waitForTimeout(3200);

    // Sometimes a second navigation happens
    try {
      await page.waitForLoadState("networkidle", { timeout: 4000 });
    } catch {
      // ok if it never becomes idle
    }

    const finalUrl = page.url();
    const title = await page.title().catch(() => "");
    const visibleText = await page.locator("body").innerText().catch(() => "");
    const html = await page.content().catch(() => "");

    // Also try meta tags and common script variables
    const metaAndScripts = await page.evaluate(() => {
      const metas = Array.from(document.querySelectorAll("meta")).map(
        (m) => `${m.getAttribute("property") || m.getAttribute("name") || ""}=${m.getAttribute("content") || ""}`
      );
      let appState = "";
      try {
        if (window.APP_INITIALIZATION_STATE) {
          appState = JSON.stringify(window.APP_INITIALIZATION_STATE).slice(0, 3000);
        }
      } catch {}
      return { metas: metas.slice(0, 40), appState };
    }).catch(() => ({ metas: [], appState: "" }));

    const candidates = [
      { source: "final_url", value: finalUrl },
      { source: "title", value: title },
      { source: "visible_text", value: visibleText },
      { source: "html", value: html },
      { source: "meta", value: metaAndScripts.metas.join("\n") },
      { source: "app_state", value: metaAndScripts.appState },
    ];

    // Prefer network-found coordinates (more reliable for some shares)
    if (networkSnippets.length > 0) {
      return {
        resolved: true,
        coordinates: networkSnippets[0].coords,
        matchedFrom: "network_response",
        finalUrl,
        title,
        htmlLength: html.length,
        networkHits: networkSnippets.length,
      };
    }

    for (const candidate of candidates) {
      const coordinates = extractCoordinates(candidate.value);
      if (coordinates) {
        return {
          resolved: true,
          coordinates,
          matchedFrom: candidate.source,
          finalUrl,
          title,
          htmlLength: html.length,
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
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 40),
      networkHits: networkSnippets.length,
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function resolveLink(link) {
  const diagnostic = {
    steps: [],
  };

  // 1) Cheap expansion first
  diagnostic.steps.push("expand_short_link");
  const expanded = await expandShortLink(link);

  if (expanded.ok) {
    diagnostic.expandedUrl = expanded.finalUrl;
    diagnostic.expandMethod = expanded.method;

    // Try coordinates from final URL
    let coords = extractCoordinates(expanded.finalUrl);
    if (coords) {
      return {
        resolved: true,
        coordinates: coords,
        matchedFrom: "expanded_url",
        finalUrl: expanded.finalUrl,
        diagnostic,
      };
    }

    // Try from body sample
    if (expanded.bodySample) {
      coords = extractCoordinates(expanded.bodySample);
      if (coords) {
        return {
          resolved: true,
          coordinates: coords,
          matchedFrom: "expanded_body",
          finalUrl: expanded.finalUrl,
          diagnostic,
        };
      }
    }
  } else {
    diagnostic.expandError = expanded.error;
  }

  // 2) Playwright fallback (if enabled)
  if (!PLAYWRIGHT_ENABLED) {
    diagnostic.steps.push("playwright_skipped");
    return {
      resolved: false,
      reason: "COORDENADAS_NAO_ENCONTRADAS_SEM_BROWSER",
      finalUrl: expanded.finalUrl || null,
      diagnostic,
    };
  }

  diagnostic.steps.push("playwright");
  try {
    const pwResult = await inspectWithPlaywright(link);
    return {
      ...pwResult,
      diagnostic,
    };
  } catch (err) {
    diagnostic.playwrightError = err?.message || String(err);
    return {
      resolved: false,
      reason: "PLAYWRIGHT_FAILED",
      error: err?.message || String(err),
      finalUrl: expanded.finalUrl || null,
      diagnostic,
    };
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "rotas-go-location-resolver",
    version: "4.1",
    playwrightEnabled: PLAYWRIGHT_ENABLED,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/version", (_req, res) => {
  res.json({
    ok: true,
    version: "4.1",
    resolver: "fetch-first-then-playwright",
    playwrightEnabled: PLAYWRIGHT_ENABLED,
  });
});

app.post("/api/location/resolve", async (req, res) => {
  const startedAt = Date.now();
  const driverId = String(req.body?.driverId || "TEST-DRIVER").trim();
  const link = String(req.body?.link || "").trim();

  console.log("[RESOLVE] start", { driverId, link: link.slice(0, 80) });

  if (!googleLink(link)) {
    return json(res, 400, {
      ok: false,
      resolved: false,
      stage: "validation",
      error: "LINK_GOOGLE_MAPS_INVALIDO",
    });
  }

  try {
    const result = await withTimeout(
      resolveLink(link),
      RESOLVE_TIMEOUT_MS,
      "resolve"
    );

    const durationMs = Date.now() - startedAt;

    if (!result.resolved) {
      console.log("[RESOLVE] not found", {
        driverId,
        durationMs,
        reason: result.reason || result.error,
        finalUrl: result.finalUrl,
      });

      return json(res, 422, {
        ok: true,
        resolved: false,
        stage: "coordinate-extraction",
        reason: result.reason || "COORDENADAS_NAO_ENCONTRADAS",
        error: result.error || null,
        durationMs,
        finalUrl: result.finalUrl ?? null,
        title: result.title ?? null,
        htmlLength: result.htmlLength ?? null,
        visibleTextSample: result.visibleTextSample ?? [],
        diagnostic: result.diagnostic ?? null,
        networkHits: result.networkHits ?? 0,
      });
    }

    const now = Date.now();
    const location = {
      driverId,
      lat: result.coordinates.lat,
      lng: result.coordinates.lng,
      source: "GOOGLE_MAPS_SHARED_LINK_TEST",
      matchedFrom: result.matchedFrom,
      updatedAt: now,
      expiresAt: now + LOCATION_TTL_MS,
    };

    locations.set(driverId, location);

    console.log("[RESOLVE] success", {
      driverId,
      durationMs,
      matchedFrom: result.matchedFrom,
      lat: location.lat,
      lng: location.lng,
    });

    return json(res, 200, {
      ok: true,
      resolved: true,
      stage: "complete",
      durationMs,
      location,
      finalUrl: result.finalUrl,
      matchedFrom: result.matchedFrom,
      diagnostic: result.diagnostic ?? null,
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;

    console.error("[RESOLVE] error", {
      driverId,
      durationMs,
      error: error?.stack || error?.message || String(error),
    });

    return json(res, 502, {
      ok: false,
      resolved: false,
      stage: "browser",
      error: error?.message || String(error),
      durationMs,
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
      expired: false,
    });
  }

  if (location.expiresAt <= Date.now()) {
    locations.delete(driverId);
    return json(res, 410, {
      ok: true,
      found: false,
      expired: true,
    });
  }

  return res.json({
    ok: true,
    found: true,
    location,
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
  console.log(`[Rotas GO] V4.1 running on port ${PORT} (playwright=${PLAYWRIGHT_ENABLED})`);
});
