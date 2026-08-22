import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const LOCATION_TTL_MS = Number(process.env.LOCATION_TTL_MS || 120000); // 2 min

app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));

const locations = new Map();

function json(res, status, payload) {
  return res.status(status).type("application/json").send(JSON.stringify(payload));
}

function cleanExpired() {
  const now = Date.now();
  for (const [id, loc] of locations) {
    if (loc.expiresAt <= now) locations.delete(id);
  }
}

// ---------- Health ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "rotas-go-location",
    version: "5.0-live",
    uptimeSeconds: Math.round(process.uptime()),
    activeDrivers: locations.size,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/version", (_req, res) => {
  res.json({
    ok: true,
    version: "5.0-live",
    mode: "device-geolocation",
  });
});

// ---------- Motorista envia localização ----------
app.post("/api/location/update", (req, res) => {
  const driverId = String(req.body?.driverId || "").trim();
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracy = req.body?.accuracy != null ? Number(req.body.accuracy) : null;

  if (!driverId) {
    return json(res, 400, { ok: false, error: "driverId_obrigatorio" });
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return json(res, 400, { ok: false, error: "coordenadas_invalidas" });
  }

  const now = Date.now();
  const location = {
    driverId,
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    source: "DEVICE_GEOLOCATION",
    updatedAt: now,
    expiresAt: now + LOCATION_TTL_MS,
  };

  locations.set(driverId, location);

  console.log("[UPDATE]", {
    driverId,
    lat,
    lng,
    accuracy: location.accuracy,
  });

  return json(res, 200, {
    ok: true,
    saved: true,
    location,
  });
});

// ---------- Consultar localização de um motorista ----------
app.get("/api/location/:driverId", (req, res) => {
  cleanExpired();
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

  return json(res, 200, {
    ok: true,
    found: true,
    location,
  });
});

// ---------- Listar motoristas ativos ----------
app.get("/api/locations", (_req, res) => {
  cleanExpired();
  const list = Array.from(locations.values()).map((loc) => ({
    driverId: loc.driverId,
    lat: loc.lat,
    lng: loc.lng,
    accuracy: loc.accuracy,
    updatedAt: loc.updatedAt,
    expiresAt: loc.expiresAt,
    ageSeconds: Math.round((Date.now() - loc.updatedAt) / 1000),
  }));

  return json(res, 200, {
    ok: true,
    count: list.length,
    locations: list,
  });
});

// ---------- Resolver link (opcional, mantido) ----------
function googleLink(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      (u.hostname === "maps.app.goo.gl" ||
        u.hostname === "goo.gl" ||
        u.hostname === "maps.google.com" ||
        u.hostname === "google.com" ||
        u.hostname.endsWith(".google.com"))
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
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  return null;
}

app.post("/api/location/resolve", async (req, res) => {
  const driverId = String(req.body?.driverId || "TEST").trim();
  const link = String(req.body?.link || "").trim();

  if (!googleLink(link)) {
    return json(res, 400, { ok: false, resolved: false, error: "LINK_INVALIDO" });
  }

  try {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    const r = await fetch(link, { headers, redirect: "follow" });
    const finalUrl = r.url;
    const coords = extractCoordinates(finalUrl);

    if (!coords) {
      return json(res, 422, {
        ok: true,
        resolved: false,
        reason: "COORDENADAS_NAO_ENCONTRADAS",
        finalUrl,
      });
    }

    const now = Date.now();
    const location = {
      driverId,
      lat: coords.lat,
      lng: coords.lng,
      source: "GOOGLE_MAPS_LINK",
      updatedAt: now,
      expiresAt: now + LOCATION_TTL_MS,
    };
    locations.set(driverId, location);

    return json(res, 200, {
      ok: true,
      resolved: true,
      location,
      finalUrl,
      matchedFrom: "expanded_url",
    });
  } catch (err) {
    return json(res, 502, {
      ok: false,
      resolved: false,
      error: err?.message || String(err),
    });
  }
});

setInterval(cleanExpired, 15000);

app.listen(PORT, () => {
  console.log(`[Rotas GO] V5.0-live on port ${PORT}`);
});
