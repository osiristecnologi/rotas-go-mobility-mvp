import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const LOCATION_TTL_MS = Number(process.env.LOCATION_TTL_MS || 120000);
const OFFER_TIMEOUT_MS = Number(process.env.OFFER_TIMEOUT_MS || 20000);
const PRICE_PER_KM = Number(process.env.PRICE_PER_KM || 1.0);
const APP_FEE = Number(process.env.APP_FEE || 0.6);

app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));

// driverId -> { driverId, name, plate, model, color, photoUrl, updatedAt }
const profiles = new Map();
// driverId -> location + status
const locations = new Map();
// rideId -> ride
const rides = new Map();
const driverSockets = new Map();
const clientSockets = new Map();

function json(res, status, payload) {
  return res.status(status).type("application/json").send(JSON.stringify(payload));
}

function cleanExpired() {
  const now = Date.now();
  for (const [id, loc] of locations) {
    if (loc.expiresAt <= now) locations.delete(id);
  }
}

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

function calcPrice(distanceKm) {
  const ride = Number((distanceKm * PRICE_PER_KM).toFixed(2));
  const total = Number((ride + APP_FEE).toFixed(2));
  return {
    distanceKm: Number(distanceKm.toFixed(2)),
    pricePerKm: PRICE_PER_KM,
    ridePrice: ride,
    appFee: APP_FEE,
    total,
  };
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

function publicDriver(driverId) {
  const p = profiles.get(driverId) || {};
  const loc = locations.get(driverId);
  return {
    driverId,
    name: p.name || driverId,
    plate: p.plate || null,
    model: p.model || null,
    color: p.color || null,
    photoUrl: p.photoUrl || null,
    lat: loc?.lat ?? null,
    lng: loc?.lng ?? null,
    accuracy: loc?.accuracy ?? null,
    status: loc?.status || "available",
    ageSeconds: loc ? Math.round((Date.now() - loc.updatedAt) / 1000) : null,
  };
}

// ---------- Health ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "rotas-go-rides",
    version: "6.0",
    uptimeSeconds: Math.round(process.uptime()),
    activeDrivers: locations.size,
    profiles: profiles.size,
    activeRides: Array.from(rides.values()).filter((r) =>
      ["searching", "offered", "accepted"].includes(r.status)
    ).length,
    pricing: { pricePerKm: PRICE_PER_KM, appFee: APP_FEE },
    timestamp: new Date().toISOString(),
  });
});

// ---------- Cadastro / perfil do motorista ----------
app.post("/api/driver/profile", (req, res) => {
  const driverId = String(req.body?.driverId || "").trim();
  const name = String(req.body?.name || "").trim();
  const plate = String(req.body?.plate || "").trim().toUpperCase();
  const model = String(req.body?.model || "").trim();
  const color = String(req.body?.color || "").trim();
  const photoUrl = String(req.body?.photoUrl || "").trim() || null;

  if (!driverId) return json(res, 400, { ok: false, error: "driverId_obrigatorio" });
  if (!name) return json(res, 400, { ok: false, error: "nome_obrigatorio" });

  const profile = {
    driverId,
    name,
    plate: plate || null,
    model: model || null,
    color: color || null,
    photoUrl,
    updatedAt: Date.now(),
  };
  profiles.set(driverId, profile);

  return json(res, 200, { ok: true, profile });
});

app.get("/api/driver/:driverId", (req, res) => {
  const p = profiles.get(req.params.driverId);
  if (!p) return json(res, 404, { ok: false, error: "perfil_nao_encontrado" });
  return json(res, 200, { ok: true, profile: publicDriver(req.params.driverId) });
});

// ---------- Localização ----------
app.post("/api/location/update", (req, res) => {
  const driverId = String(req.body?.driverId || "").trim();
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  const accuracy = req.body?.accuracy != null ? Number(req.body.accuracy) : null;

  if (!driverId) return json(res, 400, { ok: false, error: "driverId_obrigatorio" });
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

  return json(res, 200, { ok: true, saved: true, location });
});

app.get("/api/location/:driverId", (req, res) => {
  cleanExpired();
  const location = locations.get(req.params.driverId);
  if (!location) return json(res, 404, { ok: true, found: false, expired: false });
  if (location.expiresAt <= Date.now()) {
    locations.delete(req.params.driverId);
    return json(res, 410, { ok: true, found: false, expired: true });
  }
  return json(res, 200, { ok: true, found: true, location, driver: publicDriver(req.params.driverId) });
});

app.get("/api/locations", (_req, res) => {
  cleanExpired();
  const list = Array.from(locations.values()).map((loc) => publicDriver(loc.driverId));
  return json(res, 200, { ok: true, count: list.length, locations: list });
});

// ---------- Estimar preço (sem criar corrida) ----------
app.post("/api/ride/estimate", async (req, res) => {
  const origin = req.body?.origin;
  const destination = req.body?.destination;
  const valid = (p) =>
    p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

  if (!valid(origin) || !valid(destination)) {
    return json(res, 400, { ok: false, error: "origem_ou_destino_invalidos" });
  }

  const o = { lat: Number(origin.lat), lng: Number(origin.lng) };
  const d = { lat: Number(destination.lat), lng: Number(destination.lng) };

  // tenta rota real via OSRM; fallback haversine * 1.3
  let distanceKm = haversineKm(o, d) * 1.3;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}?overview=false`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.code === "Ok" && data.routes?.[0]) {
      distanceKm = data.routes[0].distance / 1000;
    }
  } catch {
    // usa fallback
  }

  const pricing = calcPrice(distanceKm);
  return json(res, 200, { ok: true, ...pricing });
});

// ---------- Despacho ----------
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
    (a, b) => haversineKm(ride.origin, a) - haversineKm(ride.origin, b)
  );

  const driver = candidates[0];
  const distanceKm = haversineKm(ride.origin, driver);

  ride.offeredTo = driver.driverId;
  ride.status = "offered";
  ride.updatedAt = Date.now();
  ride.attempts += 1;

  const profile = profiles.get(driver.driverId) || {};

  const delivered = sendTo(driverSockets, driver.driverId, {
    type: "ride_offer",
    rideId: ride.rideId,
    passengerName: ride.passengerName,
    origin: ride.origin,
    destination: ride.destination,
    distanceToPickupKm: Number(distanceKm.toFixed(2)),
    pricing: ride.pricing,
    expiresInSeconds: Math.round(OFFER_TIMEOUT_MS / 1000),
  });

  notifyClient(ride, {
    type: "ride_searching",
    rideId: ride.rideId,
    message: `Procurando motorista... (tentativa ${ride.attempts})`,
    offeredTo: profile.name || driver.driverId,
  });

  if (ride.timer) clearTimeout(ride.timer);
  const timeout = delivered ? OFFER_TIMEOUT_MS : 1500;

  ride.timer = setTimeout(() => {
    ride.rejectedBy.add(driver.driverId);
    ride.offeredTo = null;
    offerNextDriver(ride);
  }, timeout);
}

app.post("/api/ride/request", (req, res) => {
  const clientId = String(req.body?.clientId || "").trim();
  const passengerName = String(req.body?.passengerName || "Passageiro").trim();
  const origin = req.body?.origin;
  const destination = req.body?.destination;
  const pricingIn = req.body?.pricing;

  const validPoint = (p) =>
    p &&
    Number.isFinite(Number(p.lat)) &&
    Number.isFinite(Number(p.lng)) &&
    Math.abs(Number(p.lat)) <= 90 &&
    Math.abs(Number(p.lng)) <= 180;

  if (!clientId) return json(res, 400, { ok: false, error: "clientId_obrigatorio" });
  if (!validPoint(origin) || !validPoint(destination)) {
    return json(res, 400, { ok: false, error: "origem_ou_destino_invalidos" });
  }

  const o = { lat: Number(origin.lat), lng: Number(origin.lng), label: origin.label || null };
  const d = { lat: Number(destination.lat), lng: Number(destination.lng), label: destination.label || null };

  let pricing = pricingIn;
  if (!pricing || !Number.isFinite(Number(pricing.total))) {
    const km = haversineKm(o, d) * 1.3;
    pricing = calcPrice(km);
  }

  const rideId = randomUUID();
  const ride = {
    rideId,
    clientId,
    passengerName,
    origin: o,
    destination: d,
    pricing,
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

  return json(res, 200, { ok: true, rideId, status: ride.status, pricing });
});

app.get("/api/ride/:rideId", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return json(res, 404, { ok: false, error: "corrida_nao_encontrada" });

  return json(res, 200, {
    ok: true,
    rideId: ride.rideId,
    status: ride.status,
    passengerName: ride.passengerName,
    assignedDriverId: ride.assignedDriverId,
    driver: ride.assignedDriverId ? publicDriver(ride.assignedDriverId) : null,
    pricing: ride.pricing,
    attempts: ride.attempts,
    updatedAt: ride.updatedAt,
  });
});

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

  notifyClient(ride, { type: "ride_finished", rideId: ride.rideId });
  return json(res, 200, { ok: true, rideId: ride.rideId, status: ride.status });
});

// ================= WEBSOCKET =================
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  let role = null;
  let id = null;
  try {
    const url = new URL(req.url, "http://localhost");
    role = url.searchParams.get("role");
    id = url.searchParams.get("id");
  } catch {}

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
          driver: publicDriver(msg.driverId),
          pricing: ride.pricing,
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
  console.log(`[Rotas GO] V6.0 rides on port ${PORT}`);
});
