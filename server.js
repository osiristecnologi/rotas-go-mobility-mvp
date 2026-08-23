import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const LOCATION_TTL_MS = Number(process.env.LOCATION_TTL_MS || 120000); // 2 min
const OFFER_TIMEOUT_MS = Number(process.env.OFFER_TIMEOUT_MS || 20000); // 20s pra motorista responder

app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));

const locations = new Map(); // driverId -> location (com status: available|busy)
const rides = new Map(); // rideId -> ride
const driverSockets = new Map(); // driverId -> ws
const clientSockets = new Map(); // clientId -> ws

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
    version: "5.1-live",
    uptimeSeconds: Math.round(process.uptime()),
    activeDrivers: locations.size,
    activeRides: Array.from(rides.values()).filter((r) => r.status === "offered" || r.status === "searching").length,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/version", (_req, res) => {
  res.json({
    ok: true,
    version: "5.1-live",
    mode: "device-geolocation+ride-dispatch",
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
  const existing = locations.get(driverId);
  const location = {
    driverId,
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? accuracy : null,
    source: "DEVICE_GEOLOCATION",
    status: existing?.status === "busy" ? "busy" : "available",
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
    status: loc.status || "available",
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

// ================= DESPACHO DE CORRIDAS =================

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function sendTo(socketMap, id, payload) {
  const ws = socketMap.get(id);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function notifyClient(ride, payload) {
  sendTo(clientSockets, ride.clientId, payload);
}

function offerNextDriver(ride) {
  cleanExpired();

  const candidates = Array.from(locations.values()).filter(
    (loc) =>
      (loc.status || "available") === "available" &&
      !ride.rejectedBy.has(loc.driverId)
  );

  if (candidates.length === 0) {
    ride.status = "no_driver";
    ride.offeredTo = null;
    ride.updatedAt = Date.now();
    notifyClient(ride, {
      type: "ride_no_driver",
      rideId: ride.rideId,
      message: "Nenhum motorista disponível aceitou. Tente novamente.",
    });
    return;
  }

  candidates.sort(
    (a, b) =>
      haversineKm(ride.origin, a) - haversineKm(ride.origin, b)
  );

  const driver = candidates[0];
  const distanceKm = haversineKm(ride.origin, driver);

  ride.offeredTo = driver.driverId;
  ride.status = "offered";
  ride.updatedAt = Date.now();
  ride.attempts += 1;

  const delivered = sendTo(driverSockets, driver.driverId, {
    type: "ride_offer",
    rideId: ride.rideId,
    origin: ride.origin,
    destination: ride.destination,
    distanceKm: Number(distanceKm.toFixed(2)),
    expiresInSeconds: Math.round(OFFER_TIMEOUT_MS / 1000),
  });

  notifyClient(ride, {
    type: "ride_searching",
    rideId: ride.rideId,
    message: `Procurando motorista... (tentativa ${ride.attempts})`,
  });

  if (ride.timer) clearTimeout(ride.timer);

  // se o motorista não estiver com socket aberto, não adianta esperar o timeout todo — tenta o próximo mais rápido
  const timeout = delivered ? OFFER_TIMEOUT_MS : 1500;

  ride.timer = setTimeout(() => {
    ride.rejectedBy.add(driver.driverId);
    ride.offeredTo = null;
    offerNextDriver(ride);
  }, timeout);
}

// ---------- Cliente solicita corrida ----------
app.post("/api/ride/request", (req, res) => {
  const clientId = String(req.body?.clientId || "").trim();
  const origin = req.body?.origin;
  const destination = req.body?.destination;

  if (!clientId) {
    return json(res, 400, { ok: false, error: "clientId_obrigatorio" });
  }
  const validPoint = (p) =>
    p &&
    Number.isFinite(Number(p.lat)) &&
    Number.isFinite(Number(p.lng)) &&
    Math.abs(Number(p.lat)) <= 90 &&
    Math.abs(Number(p.lng)) <= 180;

  if (!validPoint(origin) || !validPoint(destination)) {
    return json(res, 400, { ok: false, error: "origem_ou_destino_invalidos" });
  }

  const rideId = randomUUID();
  const ride = {
    rideId,
    clientId,
    origin: { lat: Number(origin.lat), lng: Number(origin.lng), label: origin.label || null },
    destination: { lat: Number(destination.lat), lng: Number(destination.lng), label: destination.label || null },
    status: "searching",
    offeredTo: null,
    rejectedBy: new Set(),
    assignedDriverId: null,
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    timer: null,
  };

  rides.set(rideId, ride);
  offerNextDriver(ride);

  return json(res, 200, { ok: true, rideId, status: ride.status });
});

// ---------- Consultar status da corrida (fallback sem WS) ----------
app.get("/api/ride/:rideId", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return json(res, 404, { ok: false, error: "corrida_nao_encontrada" });

  return json(res, 200, {
    ok: true,
    rideId: ride.rideId,
    status: ride.status,
    assignedDriverId: ride.assignedDriverId,
    attempts: ride.attempts,
    updatedAt: ride.updatedAt,
  });
});

// ---------- Finalizar/cancelar corrida (libera o motorista) ----------
app.post("/api/ride/:rideId/finish", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return json(res, 404, { ok: false, error: "corrida_nao_encontrada" });

  if (ride.timer) clearTimeout(ride.timer);
  if (ride.assignedDriverId) {
    const loc = locations.get(ride.assignedDriverId);
    if (loc) loc.status = "available";
  }
  ride.status = "finished";
  ride.updatedAt = Date.now();

  return json(res, 200, { ok: true, rideId: ride.rideId, status: ride.status });
});

// ================= WEBSOCKET (push em tempo real) =================
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  let role = null;
  let id = null;
  try {
    const url = new URL(req.url, "http://localhost");
    role = url.searchParams.get("role");
    id = url.searchParams.get("id");
  } catch {
    // ignora
  }

  if (role === "driver" && id) {
    driverSockets.set(id, ws);
    ws.driverId = id;
  } else if (role === "client" && id) {
    clientSockets.set(id, ws);
    ws.clientId = id;
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "ride_response") {
      const ride = rides.get(msg.rideId);
      if (!ride || ride.status !== "offered" || ride.offeredTo !== msg.driverId) return;

      if (ride.timer) clearTimeout(ride.timer);

      if (msg.response === "accept") {
        ride.status = "accepted";
        ride.assignedDriverId = msg.driverId;
        ride.offeredTo = null;
        ride.updatedAt = Date.now();

        const loc = locations.get(msg.driverId);
        if (loc) loc.status = "busy";

        notifyClient(ride, {
          type: "ride_assigned",
          rideId: ride.rideId,
          driverId: msg.driverId,
          driverLocation: loc ? { lat: loc.lat, lng: loc.lng } : null,
        });
      } else {
        ride.rejectedBy.add(msg.driverId);
        ride.offeredTo = null;
        offerNextDriver(ride);
      }
    }
  });

  ws.on("close", () => {
    if (ws.driverId && driverSockets.get(ws.driverId) === ws) driverSockets.delete(ws.driverId);
    if (ws.clientId && clientSockets.get(ws.clientId) === ws) clientSockets.delete(ws.clientId);
  });
});

setInterval(cleanExpired, 15000);

server.listen(PORT, () => {
  console.log(`[Rotas GO] V5.1-live (com despacho de corridas) on port ${PORT}`);
});
