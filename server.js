import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
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
    /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/,
    /[?&](?:q|query|ll|center|destination|origin|daddr|saddr)=(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/i,
    /!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/,
    /data=.*?(-?\d{1,3}\.\d{4,}),(-?\d{1,3}\.\d{4,})/,
    /(-?\d{1,2}\.\d{5,})\s*[,;]\s*(-?\d{1,3}\.\d{5,})/,
    /"lat(?:itude)?"\s*:\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*"lng(?:itude)?"\s*:\s*(-?\d{1,3}(?:\.\d+)?)/i,
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
      !(Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01)
    ) {
      return { lat, lng };
    }
  }
  return null;
}

async function expandShortLink(link) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    Accept: "text/html,application/xhtml+xml",
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    // 1) manual para pegar intent:// ou Location
    const res1 = await fetch(link, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });

    let finalUrl = res1.headers.get("location") || link;
    let status = res1.status;

    // Trata intent:// ... browser_fallback_url=...
    if (finalUrl.startsWith("intent://") || finalUrl.includes("browser_fallback_url=")) {
      const m = finalUrl.match(/browser_fallback_url=([^;]+)/i);
      if (m) finalUrl = decodeURIComponent(m[1]);
    }

    // 2) segue redirects normais
    if (status >= 300 && status < 400 && finalUrl.startsWith("http")) {
      const res2 = await fetch(finalUrl, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
      finalUrl = res2.url || finalUrl;
      status = res2.status;
      const body = await res2.text().catch(() => "");
      return { ok: true, finalUrl, status, bodySample: body.slice(0, 15000) };
    }

    // fallback: follow direto do original
    const resFull = await fetch(link, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await resFull.text().catch(() => "");
    return {
      ok: true,
      finalUrl: resFull.url || finalUrl,
      status: resFull.status,
      bodySample: body.slice(0, 15000),
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "rotas-go-location-resolver",
    version: "4.1-minimal",
    playwrightEnabled: false,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/version", (_req, res) => {
  res.json({
    ok: true,
    version: "4.1-minimal",
    resolver: "fetch-only",
    playwrightEnabled: false,
  });
});

app.post("/api/location/resolve", async (req, res) => {
  const startedAt = Date.now();
  const driverId = String(req.body?.driverId || "TEST-DRIVER").trim();
  const link = String(req.body?.link || "").trim();

  console.log("[RESOLVE] start", { driverId, link: link.slice(0, 90) });

  if (!googleLink(link)) {
    return json(res, 400, {
      ok: false,
      resolved: false,
      stage: "validation",
      error: "LINK_GOOGLE_MAPS_INVALIDO",
    });
  }

  try {
    const expanded = await expandShortLink(link);
    const durationMs = Date.now() - startedAt;

    if (!expanded.ok) {
      console.error("[RESOLVE] expand failed", expanded.error);
      return json(res, 502, {
        ok: false,
        resolved: false,
        stage: "expand",
        error: expanded.error,
        durationMs,
      });
    }

    // 1) tenta na URL final
    let coords = extractCoordinates(expanded.finalUrl);
    let matchedFrom = "expanded_url";

    // 2) tenta no body
    if (!coords && expanded.bodySample) {
      coords = extractCoordinates(expanded.bodySample);
      matchedFrom = "expanded_body";
    }

    if (!coords) {
      console.log("[RESOLVE] not found", {
        driverId,
        durationMs,
        finalUrl: expanded.finalUrl,
      });

      return json(res, 422, {
        ok: true,
        resolved: false,
        stage: "coordinate-extraction",
        reason: "COORDENADAS_NAO_ENCONTRADAS",
        durationMs,
        finalUrl: expanded.finalUrl,
        status: expanded.status,
        bodyLength: expanded.bodySample?.length ?? 0,
        note: "Versão minimal (sem Playwright). Links de lugar com @lat,lng na URL final costumam funcionar. Shares ao vivo raramente expõem coordenadas.",
      });
    }

    const now = Date.now();
    const location = {
      driverId,
      lat: coords.lat,
      lng: coords.lng,
      source: "GOOGLE_MAPS_SHARED_LINK_FETCH",
      matchedFrom,
      updatedAt: now,
      expiresAt: now + LOCATION_TTL_MS,
    };

    locations.set(driverId, location);

    console.log("[RESOLVE] success", {
      driverId,
      durationMs,
      matchedFrom,
      lat: location.lat,
      lng: location.lng,
    });

    return json(res, 200, {
      ok: true,
      resolved: true,
      stage: "complete",
      durationMs,
      location,
      finalUrl: expanded.finalUrl,
      matchedFrom,
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    console.error("[RESOLVE] error", error?.stack || error?.message);
    return json(res, 502, {
      ok: false,
      resolved: false,
      stage: "expand",
      error: error?.message || String(error),
      durationMs,
    });
  }
});

app.get("/api/location/:driverId", (req, res) => {
  const driverId = req.params.driverId;
  const location = locations.get(driverId);

  if (!location) {
    return json(res, 404, { ok: true, found: false, expired: false });
  }

  if (location.expiresAt <= Date.now()) {
    locations.delete(driverId);
    return json(res, 410, { ok: true, found: false, expired: true });
  }

  return res.json({ ok: true, found: true, location });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, loc] of locations) {
    if (loc.expiresAt <= now) locations.delete(id);
  }
}, 10000);

app.listen(PORT, () => {
  console.log(`[Rotas GO] V4.1-minimal (fetch-only) on port ${PORT}`);
});
