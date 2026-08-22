import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const LOCATION_TTL_MS = Number(process.env.LOCATION_TTL_MS || 90_000);
const OFFER_TIMEOUT_MS = Number(process.env.OFFER_TIMEOUT_MS || 15_000);

const drivers = new Map();
const passengers = new Map();
const rides = new Map();
const sockets = new Map();

const now = () => Date.now();
const id = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (v) => v * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function publicDriver(d) {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    lat: d.lat,
    lng: d.lng,
    accuracy: d.accuracy,
    locationSource: d.locationSource,
    locationUpdatedAt: d.locationUpdatedAt,
    locationExpiresAt: d.locationExpiresAt
  };
}

function broadcast(type, payload) {
  const message = JSON.stringify({ type, payload, at: now() });
  for (const ws of wss.clients) {
    if (ws.readyState === 1) ws.send(message);
  }
}

function sendToDriver(driverId, type, payload) {
  const ws = sockets.get(`driver:${driverId}`);
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type, payload, at: now() }));
}

function sendToPassenger(passengerId, type, payload) {
  const ws = sockets.get(`passenger:${passengerId}`);
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type, payload, at: now() }));
}

function locationFresh(d) {
  return d.lat != null &&
    d.lng != null &&
    d.locationExpiresAt != null &&
    d.locationExpiresAt > now();
}

function availableDriversNear(lat, lng, radiusKm = 10) {
  return [...drivers.values()]
    .filter(d => d.status === "AVAILABLE" && locationFresh(d))
    .map(d => ({ ...publicDriver(d), distanceKm: distanceKm(lat, lng, d.lat, d.lng) }))
    .filter(d => d.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

async function offerNextDriver(ride) {
  const candidates = availableDriversNear(ride.pickup.lat, ride.pickup.lng, ride.searchRadiusKm)
    .filter(d => !ride.triedDriverIds.includes(d.id));

  if (!candidates.length) {
    ride.status = "NO_DRIVER";
    ride.updatedAt = now();
    sendToPassenger(ride.passengerId, "RIDE_NO_DRIVER", ride);
    broadcast("RIDE_UPDATED", ride);
    return;
  }

  const candidate = candidates[0];
  ride.triedDriverIds.push(candidate.id);
  ride.currentDriverId = candidate.id;
  ride.status = "OFFERED";
  ride.updatedAt = now();

  const driver = drivers.get(candidate.id);
  if (driver) driver.status = "OFFERED";

  sendToDriver(candidate.id, "RIDE_OFFER", {
    ride,
    pickupDistanceKm: candidate.distanceKm
  });
  sendToPassenger(ride.passengerId, "RIDE_UPDATED", ride);
  broadcast("RIDE_UPDATED", ride);

  setTimeout(async () => {
    const current = rides.get(ride.id);
    if (!current || current.status !== "OFFERED" || current.currentDriverId !== candidate.id) return;
    const d = drivers.get(candidate.id);
    if (d && d.status === "OFFERED") d.status = "AVAILABLE";
    await offerNextDriver(current);
  }, OFFER_TIMEOUT_MS);
}

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  drivers: drivers.size,
  rides: rides.size,
  locationTtlSeconds: LOCATION_TTL_MS / 1000
}));

app.get("/api/drivers", (_req, res) => {
  res.json([...drivers.values()].map(publicDriver));
});

app.get("/api/rides", (_req, res) => {
  res.json([...rides.values()]);
});

app.post("/api/drivers/register", (req, res) => {
  const name = String(req.body.name || "").trim() || "Motorista";
  const driver = {
    id: id("DRV"),
    name,
    status: "OFFLINE",
    lat: null,
    lng: null,
    accuracy: null,
    locationSource: null,
    locationUpdatedAt: null,
    locationExpiresAt: null,
    shiftStartedAt: null
  };
  drivers.set(driver.id, driver);
  res.status(201).json(publicDriver(driver));
});

app.post("/api/drivers/:driverId/shift/start", (req, res) => {
  const d = drivers.get(req.params.driverId);
  if (!d) return res.status(404).json({ error: "driver_not_found" });

  d.status = "AVAILABLE";
  d.shiftStartedAt = now();

  if (Number.isFinite(req.body.lat) && Number.isFinite(req.body.lng)) {
    d.lat = req.body.lat;
    d.lng = req.body.lng;
    d.accuracy = Number.isFinite(req.body.accuracy) ? req.body.accuracy : null;
    d.locationSource = "GPS";
    d.locationUpdatedAt = now();
    d.locationExpiresAt = now() + LOCATION_TTL_MS;
  }

  broadcast("DRIVER_UPDATED", publicDriver(d));
  res.json(publicDriver(d));
});

app.post("/api/drivers/:driverId/location", (req, res) => {
  const d = drivers.get(req.params.driverId);
  if (!d) return res.status(404).json({ error: "driver_not_found" });

  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "invalid_coordinates" });
  }

  d.lat = lat;
  d.lng = lng;
  d.accuracy = Number.isFinite(Number(req.body.accuracy)) ? Number(req.body.accuracy) : null;
  d.locationSource = req.body.source === "RIDE_DESTINATION" ? "RIDE_DESTINATION" : "GPS";
  d.locationUpdatedAt = now();
  d.locationExpiresAt = now() + LOCATION_TTL_MS;

  if (d.status === "OFFLINE") d.status = "AVAILABLE";
  broadcast("DRIVER_UPDATED", publicDriver(d));
  res.json(publicDriver(d));
});

app.post("/api/drivers/:driverId/shift/stop", (req, res) => {
  const d = drivers.get(req.params.driverId);
  if (!d) return res.status(404).json({ error: "driver_not_found" });
  d.status = "OFFLINE";
  d.locationExpiresAt = now();
  broadcast("DRIVER_UPDATED", publicDriver(d));
  res.json(publicDriver(d));
});

app.post("/api/drivers/:driverId/status", (req, res) => {
  const d = drivers.get(req.params.driverId);
  if (!d) return res.status(404).json({ error: "driver_not_found" });
  const allowed = ["AVAILABLE", "OFFLINE"];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: "invalid_status" });
  d.status = req.body.status;
  broadcast("DRIVER_UPDATED", publicDriver(d));
  res.json(publicDriver(d));
});

app.post("/api/rides", async (req, res) => {
  const passengerId = String(req.body.passengerId || "PASSENGER-DEMO");
  const pickup = {
    lat: Number(req.body.pickupLat),
    lng: Number(req.body.pickupLng),
    label: String(req.body.pickupLabel || "Origem")
  };
  const destination = {
    lat: req.body.destinationLat == null ? null : Number(req.body.destinationLat),
    lng: req.body.destinationLng == null ? null : Number(req.body.destinationLng),
    label: String(req.body.destinationLabel || "Destino")
  };

  if (!Number.isFinite(pickup.lat) || !Number.isFinite(pickup.lng)) {
    return res.status(400).json({ error: "invalid_pickup_coordinates" });
  }

  const ride = {
    id: id("RIDE"),
    passengerId,
    pickup,
    destination,
    status: "SEARCHING",
    currentDriverId: null,
    triedDriverIds: [],
    searchRadiusKm: Number(req.body.searchRadiusKm || 10),
    createdAt: now(),
    updatedAt: now()
  };

  rides.set(ride.id, ride);
  await offerNextDriver(ride);
  res.status(201).json(ride);
});

app.post("/api/rides/:rideId/accept", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return res.status(404).json({ error: "ride_not_found" });

  const driverId = String(req.body.driverId || "");
  if (ride.status !== "OFFERED" || ride.currentDriverId !== driverId) {
    return res.status(409).json({ error: "ride_not_offered_to_driver" });
  }

  const d = drivers.get(driverId);
  if (!d) return res.status(404).json({ error: "driver_not_found" });

  d.status = "BUSY";
  ride.status = "ACCEPTED";
  ride.updatedAt = now();

  sendToPassenger(ride.passengerId, "RIDE_ACCEPTED", ride);
  broadcast("RIDE_UPDATED", ride);
  broadcast("DRIVER_UPDATED", publicDriver(d));
  res.json(ride);
});

app.post("/api/rides/:rideId/reject", async (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return res.status(404).json({ error: "ride_not_found" });

  const driverId = String(req.body.driverId || "");
  if (ride.status !== "OFFERED" || ride.currentDriverId !== driverId) {
    return res.status(409).json({ error: "ride_not_offered_to_driver" });
  }

  const d = drivers.get(driverId);
  if (d) d.status = "AVAILABLE";
  ride.currentDriverId = null;
  ride.status = "SEARCHING";
  ride.updatedAt = now();

  broadcast("DRIVER_UPDATED", d ? publicDriver(d) : null);
  await offerNextDriver(ride);
  res.json(ride);
});

app.post("/api/rides/:rideId/start", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return res.status(404).json({ error: "ride_not_found" });
  if (ride.status !== "ACCEPTED") return res.status(409).json({ error: "invalid_ride_state" });
  ride.status = "IN_PROGRESS";
  ride.updatedAt = now();
  broadcast("RIDE_UPDATED", ride);
  res.json(ride);
});

app.post("/api/rides/:rideId/complete", (req, res) => {
  const ride = rides.get(req.params.rideId);
  if (!ride) return res.status(404).json({ error: "ride_not_found" });

  const d = ride.currentDriverId ? drivers.get(ride.currentDriverId) : null;
  ride.status = "COMPLETED";
  ride.updatedAt = now();

  if (d) {
    d.status = "AVAILABLE";
    if (Number.isFinite(ride.destination.lat) && Number.isFinite(ride.destination.lng)) {
      d.lat = ride.destination.lat;
      d.lng = ride.destination.lng;
      d.accuracy = null;
      d.locationSource = "RIDE_DESTINATION";
      d.locationUpdatedAt = now();
      d.locationExpiresAt = now() + LOCATION_TTL_MS;
    }
    broadcast("DRIVER_UPDATED", publicDriver(d));
  }

  broadcast("RIDE_UPDATED", ride);
  res.json({ ride, driver: d ? publicDriver(d) : null });
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const role = url.searchParams.get("role");
  const entityId = url.searchParams.get("id");

  if (role && entityId) sockets.set(`${role}:${entityId}`, ws);

  ws.send(JSON.stringify({
    type: "CONNECTED",
    payload: {
      role,
      entityId,
      drivers: [...drivers.values()].map(publicDriver),
      rides: [...rides.values()]
    },
    at: now()
  }));

  ws.on("close", () => {
    if (role && entityId && sockets.get(`${role}:${entityId}`) === ws) {
      sockets.delete(`${role}:${entityId}`);
    }
  });
});

setInterval(() => {
  const t = now();
  for (const d of drivers.values()) {
    if (d.status !== "OFFLINE" && d.locationExpiresAt && d.locationExpiresAt <= t) {
      if (d.status !== "BUSY") d.status = "OFFLINE";
      broadcast("DRIVER_UPDATED", publicDriver(d));
    }
  }
}, 10_000);

server.listen(PORT, () => {
  console.log(`Rotas GO Mobility MVP: http://localhost:${PORT}`);
});
