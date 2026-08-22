import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const TTL_MS = Number(process.env.LOCATION_TTL_MS || 90_000);

app.use(express.json());
app.use(express.static("public"));

const cache = new Map();

function extractCoordinates(text) {
  if (!text) return null;

  // Padrões comuns encontrados em URLs/textos de mapas.
  const patterns = [
    /[?&](?:q|query|ll|center|destination)=(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/i,
    /@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,|z|\/|$)/i,
    /!3d(-?\d{1,3}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/i,
    /(-?\d{1,3}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})/
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;

    const lat = Number(m[1]);
    const lng = Number(m[2]);

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

async function resolveGoogleMapsLink(link) {
  if (!validMapsLink(link)) {
    throw new Error("LINK_GOOGLE_MAPS_INVALIDO");
  }

  const response = await fetch(link, {
    redirect: "follow",
    headers: {
      "User-Agent": "RotasGO-LocationResolver/0.1"
    }
  });

  const finalUrl = response.url || link;
  const html = await response.text();

  let coords = extractCoordinates(finalUrl);

  if (!coords) {
    coords = extractCoordinates(html);
  }

  if (!coords) {
    return {
      resolved: false,
      finalUrl,
      status: response.status,
      message:
        "O link foi resolvido, mas não foi encontrada uma latitude/longitude em formato reconhecível. O formato do Google pode mudar ou exigir uma integração oficial."
    };
  }

  return {
    resolved: true,
    finalUrl,
    status: response.status,
    ...coords
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "rotas-go-location-resolver-test"
  });
});

app.post("/api/location/resolve", async (req, res) => {
  const link = String(req.body.link || "").trim();

  if (!link) {
    return res.status(400).json({
      resolved: false,
      error: "LINK_REQUIRED"
    });
  }

  try {
    const result = await resolveGoogleMapsLink(link);

    if (result.resolved) {
      const record = {
        lat: result.lat,
        lng: result.lng,
        source: "GOOGLE_MAPS_SHARED_LINK",
        sourceLink: link,
        updatedAt: Date.now(),
        expiresAt: Date.now() + TTL_MS
      };

      cache.set(String(req.body.driverId || "TEST-DRIVER"), record);

      return res.json({
        ...result,
        location: record
      });
    }

    return res.status(422).json(result);
  } catch (error) {
    console.error(error);
    return res.status(502).json({
      resolved: false,
      error: "MAPS_RESOLUTION_FAILED",
      message: error.message
    });
  }
});

app.get("/api/location/:driverId", (req, res) => {
  const record = cache.get(req.params.driverId);

  if (!record) {
    return res.status(404).json({
      found: false,
      message: "Nenhuma localização encontrada."
    });
  }

  if (record.expiresAt <= Date.now()) {
    cache.delete(req.params.driverId);
    return res.status(410).json({
      found: false,
      expired: true
    });
  }

  res.json({
    found: true,
    location: record
  });
});

app.delete("/api/location/:driverId", (req, res) => {
  cache.delete(req.params.driverId);
  res.json({ ok: true });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, record] of cache) {
    if (record.expiresAt <= now) cache.delete(id);
  }
}, 10_000);

app.listen(PORT, () => {
  console.log(`Rotas GO Location Resolver: http://localhost:${PORT}`);
});
