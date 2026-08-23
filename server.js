import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { randomUUID } from "crypto";
import multer from "multer";
import fs from "fs";
import path from "path";
import pg from "pg";

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;
const LOCATION_TTL_MS = Number(process.env.LOCATION_TTL_MS || 120000);
const OFFER_TIMEOUT_MS = Number(process.env.OFFER_TIMEOUT_MS || 20000);
const PRICE_PER_KM = Number(process.env.PRICE_PER_KM || 1.0);
const APP_FEE = Number(process.env.APP_FEE || 0.6);
const FREE_CANCEL_LIMIT = 2;
const CANCEL_FEE = 5.0;
const ARRIVED_RADIUS_M = Number(process.env.ARRIVED_RADIUS_M || 120);

// Render Postgres: use DATABASE_URL; internal host works only inside Render
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://rotasgo_user:hqcESTPUQfklSji9dbg5vlrZgJeSBB3l@dpg-da12n5e1egvs739rijt0-a/rotasgo";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === "0" ? false : { rejectUnauthorized: false },
  max: 5,
});

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safe = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
    cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error("Apenas imagens JPG, PNG, WEBP ou GIF"));
  },
});

app.use(express.json({ limit: "64kb" }));
app.use(express.static("public"));
app.use("/uploads", express.static(UPLOAD_DIR));

// runtime only (sockets + offer timers)
const ridesRuntime = new Map(); // rideId -> { timer, rejectedBy: Set }
const driverSockets = new Map();
const clientSockets = new Map();

function json(res, status, payload) {
  return res.status(status).type("application/json").send(JSON.stringify(payload));
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drivers (
      driver_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plate TEXT,
      model TEXT,
      color TEXT,
      photo_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS locations (
      driver_id TEXT PRIMARY KEY REFERENCES drivers(driver_id) ON DELETE CASCADE,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      accuracy DOUBLE PRECISION,
      status TEXT NOT NULL DEFAULT 'available',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rides (
      ride_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      passenger_name TEXT,
      origin_lat DOUBLE PRECISION NOT NULL,
      origin_lng DOUBLE PRECISION NOT NULL,
      origin_label TEXT,
      dest_lat DOUBLE PRECISION NOT NULL,
      dest_lng DOUBLE PRECISION NOT NULL,
      dest_label TEXT,
      pricing JSONB,
      status TEXT NOT NULL,
      offered_to TEXT,
      assigned_driver_id TEXT,
      attempts INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS client_stats (
      client_id TEXT PRIMARY KEY,
      cancel_count INT NOT NULL DEFAULT 0,
      pending_fee DOUBLE PRECISION NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_locations_expires ON locations(expires_at);
    CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
  `);
  console.log("[DB] tables ready");
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

function haversineM(a, b) {
  return haversineKm(a, b) * 1000;
}

const SERVICE_PRICING = {
  ride: { pricePerKm: 2.0, appFee: 0.8, label: "Motorista" },
  delivery: { pricePerKm: 1.2, appFee: 0.6, label: "Entrega" },
};

function getServicePricing(serviceType) {
  return SERVICE_PRICING[serviceType] || SERVICE_PRICING.ride;
}

function calcPrice(distanceKm, serviceType = "ride") {
  const cfg = getServicePricing(serviceType);
  const ride = Number((distanceKm * cfg.pricePerKm).toFixed(2));
  const total = Number((ride + cfg.appFee).toFixed(2));
  return {
    serviceType,
    serviceLabel: cfg.label,
    distanceKm: Number(distanceKm.toFixed(2)),
    pricePerKm: cfg.pricePerKm,
    ridePrice: ride,
    appFee: cfg.appFee,
    total,
  };
}

/** ETA rough: assume 25 km/h urban average */
function etaMinutes(distanceKm) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 1;
  return Math.max(1, Math.round((distanceKm / 25) * 60));
}

function sendTo(socketMap, id, payload) {
  const ws = socketMap.get(id);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function notifyClient(clientId, payload) {
  sendTo(clientSockets, clientId, payload);
}

async function cleanExpired() {
  await pool.query(`DELETE FROM locations WHERE expires_at <= NOW()`);
}

async function publicDriver(driverId) {
  const { rows } = await pool.query(
    `SELECT d.driver_id, d.name, d.plate, d.model, d.color, d.photo_url,
            l.lat, l.lng, l.accuracy, l.status, l.updated_at
     FROM drivers d
     LEFT JOIN locations l ON l.driver_id = d.driver_id AND l.expires_at > NOW()
     WHERE d.driver_id = $1`,
    [driverId]
  );
  if (!rows.length) {
    return {
      driverId,
      name: driverId,
      plate: null,
      model: null,
      color: null,
      photoUrl: null,
      lat: null,
      lng: null,
      accuracy: null,
      status: "offline",
      ageSeconds: null,
    };
  }
  const r = rows[0];
  return {
    driverId: r.driver_id,
    name: r.name || driverId,
    plate: r.plate,
    model: r.model,
    color: r.color,
    photoUrl: r.photo_url,
    lat: r.lat != null ? Number(r.lat) : null,
    lng: r.lng != null ? Number(r.lng) : null,
    accuracy: r.accuracy != null ? Number(r.accuracy) : null,
    status: r.status || (r.lat != null ? "available" : "offline"),
    ageSeconds:
      r.updated_at != null
        ? Math.round((Date.now() - new Date(r.updated_at).getTime()) / 1000)
        : null,
  };
}

async function listOnlineDrivers() {
  const { rows } = await pool.query(
    `SELECT d.driver_id, d.name, d.plate, d.model, d.color, d.photo_url,
            l.lat, l.lng, l.accuracy, l.status, l.updated_at
     FROM locations l
     JOIN drivers d ON d.driver_id = l.driver_id
     WHERE l.expires_at > NOW()
     ORDER BY l.updated_at DESC`
  );
  return rows.map((r) => ({
    driverId: r.driver_id,
    name: r.name,
    plate: r.plate,
    model: r.model,
    color: r.color,
    photoUrl: r.photo_url,
    lat: Number(r.lat),
    lng: Number(r.lng),
    accuracy: r.accuracy != null ? Number(r.accuracy) : null,
    status: r.status || "available",
    ageSeconds: Math.round((Date.now() - new Date(r.updated_at).getTime()) / 1000),
  }));
}

// ---------- Health ----------
app.get("/health", async (_req, res) => {
  let dbOk = false;
  let activeDrivers = 0;
  try {
    await pool.query("SELECT 1");
    dbOk = true;
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM locations WHERE expires_at > NOW()`
    );
    activeDrivers = r.rows[0].c;
  } catch (e) {
    console.error("[DB] health", e.message);
  }
  res.json({
    ok: true,
    service: "rotas-go-rides",
    version: "7.2",
    db: dbOk,
    uptimeSeconds: Math.round(process.uptime()),
    activeDrivers,
    pricing: SERVICE_PRICING,
    timestamp: new Date().toISOString(),
  });
});

// ---------- Upload ----------
app.post("/api/upload/photo", (req, res) => {
  upload.single("photo")(req, res, (err) => {
    if (err) return json(res, 400, { ok: false, error: err.message || "upload_falhou" });
    if (!req.file) return json(res, 400, { ok: false, error: "arquivo_obrigatorio" });
    return json(res, 200, {
      ok: true,
      photoUrl: `/uploads/${req.file.filename}`,
      size: req.file.size,
      mime: req.file.mimetype,
    });
  });
});

// ---------- Driver profile ----------
app.post("/api/driver/profile", async (req, res) => {
  try {
    const driverId = String(req.body?.driverId || "").trim();
    const name = String(req.body?.name || "").trim();
    const plate = String(req.body?.plate || "").trim().toUpperCase() || null;
    const model = String(req.body?.model || "").trim() || null;
    const color = String(req.body?.color || "").trim() || null;
    const photoUrl = String(req.body?.photoUrl || "").trim() || null;
    if (!driverId) return json(res, 400, { ok: false, error: "driverId_obrigatorio" });
    if (!name) return json(res, 400, { ok: false, error: "nome_obrigatorio" });

    await pool.query(
      `INSERT INTO drivers (driver_id, name, plate, model, color, photo_url, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (driver_id) DO UPDATE SET
         name=EXCLUDED.name, plate=EXCLUDED.plate, model=EXCLUDED.model,
         color=EXCLUDED.color, photo_url=COALESCE(EXCLUDED.photo_url, drivers.photo_url),
         updated_at=NOW()`,
      [driverId, name, plate, model, color, photoUrl]
    );
    return json(res, 200, {
      ok: true,
      profile: { driverId, name, plate, model, color, photoUrl },
    });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e.message });
  }
});

app.get("/api/driver/:driverId", async (req, res) => {
  try {
    const profile = await publicDriver(req.params.driverId);
    return json(res, 200, { ok: true, profile });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

// ---------- Location ----------
app.post("/api/location/update", async (req, res) => {
  try {
    const driverId = String(req.body?.driverId || "").trim();
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const accuracy = req.body?.accuracy != null ? Number(req.body.accuracy) : null;
    if (!driverId) return json(res, 400, { ok: false, error: "driverId_obrigatorio" });
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return json(res, 400, { ok: false, error: "coordenadas_invalidas" });
    }

    // ensure driver row exists
    await pool.query(
      `INSERT INTO drivers (driver_id, name, updated_at) VALUES ($1,$1,NOW())
       ON CONFLICT (driver_id) DO NOTHING`,
      [driverId]
    );

    const prev = await pool.query(
      `SELECT status FROM locations WHERE driver_id=$1`,
      [driverId]
    );
    const status = prev.rows[0]?.status === "busy" ? "busy" : "available";
    const expiresAt = new Date(Date.now() + LOCATION_TTL_MS);

    await pool.query(
      `INSERT INTO locations (driver_id, lat, lng, accuracy, status, updated_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6)
       ON CONFLICT (driver_id) DO UPDATE SET
         lat=EXCLUDED.lat, lng=EXCLUDED.lng, accuracy=EXCLUDED.accuracy,
         status=CASE WHEN locations.status='busy' THEN 'busy' ELSE EXCLUDED.status END,
         updated_at=NOW(), expires_at=EXCLUDED.expires_at`,
      [driverId, lat, lng, accuracy, status, expiresAt]
    );

    // push live position to clients watching accepted rides with this driver
    const active = await pool.query(
      `SELECT ride_id, client_id, origin_lat, origin_lng, status
       FROM rides WHERE assigned_driver_id=$1 AND status='accepted'`,
      [driverId]
    );
    for (const ride of active.rows) {
      const distM = haversineM(
        { lat, lng },
        { lat: Number(ride.origin_lat), lng: Number(ride.origin_lng) }
      );
      const distKm = distM / 1000;
      const eta = etaMinutes(distKm);
      let phase = "en_route";
      let message = `Motorista a caminho · aguarde ~${eta} min`;
      if (distM <= ARRIVED_RADIUS_M) {
        phase = "arrived";
        message = "Seu motorista chegou!";
      }
      notifyClient(ride.client_id, {
        type: "driver_position",
        rideId: ride.ride_id,
        driverId,
        lat,
        lng,
        accuracy,
        distanceMeters: Math.round(distM),
        etaMinutes: eta,
        phase,
        message,
      });
    }

    return json(res, 200, {
      ok: true,
      saved: true,
      location: { driverId, lat, lng, accuracy, status },
    });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e.message });
  }
});

app.get("/api/location/:driverId", async (req, res) => {
  try {
    await cleanExpired();
    const { rows } = await pool.query(
      `SELECT * FROM locations WHERE driver_id=$1 AND expires_at > NOW()`,
      [req.params.driverId]
    );
    if (!rows.length) return json(res, 404, { ok: true, found: false, expired: false });
    const loc = rows[0];
    return json(res, 200, {
      ok: true,
      found: true,
      location: {
        driverId: loc.driver_id,
        lat: Number(loc.lat),
        lng: Number(loc.lng),
        accuracy: loc.accuracy != null ? Number(loc.accuracy) : null,
        status: loc.status,
        updatedAt: new Date(loc.updated_at).getTime(),
        expiresAt: new Date(loc.expires_at).getTime(),
      },
      driver: await publicDriver(req.params.driverId),
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

app.get("/api/locations", async (_req, res) => {
  try {
    await cleanExpired();
    const list = await listOnlineDrivers();
    return json(res, 200, { ok: true, count: list.length, locations: list });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

// ---------- Estimate ----------
app.post("/api/ride/estimate", async (req, res) => {
  const origin = req.body?.origin;
  const destination = req.body?.destination;
  const valid = (p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
  if (!valid(origin) || !valid(destination)) {
    return json(res, 400, { ok: false, error: "origem_ou_destino_invalidos" });
  }
  const o = { lat: Number(origin.lat), lng: Number(origin.lng) };
  const d = { lat: Number(destination.lat), lng: Number(destination.lng) };
  const serviceType = String(req.body?.serviceType || "ride");
  let distanceKm = haversineKm(o, d) * 1.3;
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}?overview=false`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.code === "Ok" && data.routes?.[0]) distanceKm = data.routes[0].distance / 1000;
  } catch {}
  return json(res, 200, { ok: true, ...calcPrice(distanceKm, serviceType) });
});

app.get("/api/client/:clientId/stats", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cancel_count, pending_fee FROM client_stats WHERE client_id=$1`,
      [req.params.clientId]
    );
    const stats = rows[0] || { cancel_count: 0, pending_fee: 0 };
    return json(res, 200, {
      ok: true,
      cancelCount: stats.cancel_count,
      freeLeft: Math.max(0, FREE_CANCEL_LIMIT - stats.cancel_count),
      pendingFee: Number(stats.pending_fee),
      freeCancelLimit: FREE_CANCEL_LIMIT,
      cancelFee: CANCEL_FEE,
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

// ---------- Dispatch ----------
async function offerNextDriver(rideId) {
  await cleanExpired();
  const { rows } = await pool.query(`SELECT * FROM rides WHERE ride_id=$1`, [rideId]);
  if (!rows.length) return;
  const ride = rows[0];
  if (!["searching", "offered"].includes(ride.status)) return;

  const rt = ridesRuntime.get(rideId) || { timer: null, rejectedBy: new Set() };
  ridesRuntime.set(rideId, rt);

  const online = await listOnlineDrivers();
  const candidates = online.filter(
    (loc) =>
      (loc.status || "available") === "available" &&
      !rt.rejectedBy.has(loc.driverId)
  );

  if (!candidates.length) {
    await pool.query(
      `UPDATE rides SET status='no_driver', offered_to=NULL, updated_at=NOW() WHERE ride_id=$1`,
      [rideId]
    );
    notifyClient(ride.client_id, {
      type: "ride_no_driver",
      rideId,
      message: "Nenhum motorista disponível aceitou. Tente novamente.",
    });
    return;
  }

  const origin = { lat: Number(ride.origin_lat), lng: Number(ride.origin_lng) };
  candidates.sort((a, b) => haversineKm(origin, a) - haversineKm(origin, b));
  const driver = candidates[0];
  const distanceKm = haversineKm(origin, driver);
  const attempts = (ride.attempts || 0) + 1;

  await pool.query(
    `UPDATE rides SET status='offered', offered_to=$2, attempts=$3, updated_at=NOW() WHERE ride_id=$1`,
    [rideId, driver.driverId, attempts]
  );

  const pricing = ride.pricing || {};
  const delivered = sendTo(driverSockets, driver.driverId, {
    type: "ride_offer",
    rideId,
    passengerName: ride.passenger_name,
    origin: {
      lat: Number(ride.origin_lat),
      lng: Number(ride.origin_lng),
      label: ride.origin_label,
    },
    destination: {
      lat: Number(ride.dest_lat),
      lng: Number(ride.dest_lng),
      label: ride.dest_label,
    },
    distanceToPickupKm: Number(distanceKm.toFixed(2)),
    pricing,
    expiresInSeconds: Math.round(OFFER_TIMEOUT_MS / 1000),
  });

  notifyClient(ride.client_id, {
    type: "ride_searching",
    rideId,
    message: `Procurando motorista... (tentativa ${attempts})`,
    offeredTo: driver.name || driver.driverId,
  });

  if (rt.timer) clearTimeout(rt.timer);
  const timeout = delivered ? OFFER_TIMEOUT_MS : 1500;
  rt.timer = setTimeout(async () => {
    rt.rejectedBy.add(driver.driverId);
    await pool.query(
      `UPDATE rides SET offered_to=NULL, status='searching', updated_at=NOW() WHERE ride_id=$1 AND status='offered'`,
      [rideId]
    );
    offerNextDriver(rideId);
  }, timeout);
}

app.post("/api/ride/request", async (req, res) => {
  try {
    const clientId = String(req.body?.clientId || "").trim();
    const passengerName = String(req.body?.passengerName || "Passageiro").trim();
    const origin = req.body?.origin;
    const destination = req.body?.destination;
    const pricingIn = req.body?.pricing;
    const serviceType = String(req.body?.serviceType || pricingIn?.serviceType || "ride");
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

    const o = {
      lat: Number(origin.lat),
      lng: Number(origin.lng),
      label: origin.label || null,
    };
    const d = {
      lat: Number(destination.lat),
      lng: Number(destination.lng),
      label: destination.label || null,
    };

    let pricing = pricingIn;
    if (!pricing || !Number.isFinite(Number(pricing.total))) {
      pricing = calcPrice(haversineKm(o, d) * 1.3, serviceType);
    } else if (!pricing.serviceType) {
      pricing = { ...pricing, serviceType, serviceLabel: getServicePricing(serviceType).label };
    }

    const st = await pool.query(
      `SELECT cancel_count, pending_fee FROM client_stats WHERE client_id=$1`,
      [clientId]
    );
    let pendingFee = Number(st.rows[0]?.pending_fee || 0);
    if (pendingFee > 0) {
      pricing = {
        ...pricing,
        cancelFee: pendingFee,
        total: Number((Number(pricing.total) + pendingFee).toFixed(2)),
      };
      await pool.query(
        `UPDATE client_stats SET pending_fee=0 WHERE client_id=$1`,
        [clientId]
      );
    }

    const rideId = randomUUID();
    await pool.query(
      `INSERT INTO rides (
        ride_id, client_id, passenger_name,
        origin_lat, origin_lng, origin_label,
        dest_lat, dest_lng, dest_label,
        pricing, status, attempts, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'searching',0,NOW(),NOW())`,
      [
        rideId,
        clientId,
        passengerName,
        o.lat,
        o.lng,
        o.label,
        d.lat,
        d.lng,
        d.label,
        JSON.stringify(pricing),
      ]
    );

    ridesRuntime.set(rideId, { timer: null, rejectedBy: new Set() });
    offerNextDriver(rideId);

    return json(res, 200, { ok: true, rideId, status: "searching", pricing });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e.message });
  }
});

app.get("/api/ride/:rideId", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM rides WHERE ride_id=$1`, [
      req.params.rideId,
    ]);
    if (!rows.length) return json(res, 404, { ok: false, error: "corrida_nao_encontrada" });
    const ride = rows[0];
    let driver = null;
    let tracking = null;
    if (ride.assigned_driver_id) {
      driver = await publicDriver(ride.assigned_driver_id);
      if (driver.lat != null) {
        const distM = haversineM(
          { lat: driver.lat, lng: driver.lng },
          { lat: Number(ride.origin_lat), lng: Number(ride.origin_lng) }
        );
        const eta = etaMinutes(distM / 1000);
        tracking = {
          distanceMeters: Math.round(distM),
          etaMinutes: eta,
          phase: distM <= ARRIVED_RADIUS_M ? "arrived" : "en_route",
          message:
            distM <= ARRIVED_RADIUS_M
              ? "Seu motorista chegou!"
              : `Motorista a caminho · aguarde ~${eta} min`,
        };
      }
    }
    return json(res, 200, {
      ok: true,
      rideId: ride.ride_id,
      status: ride.status,
      passengerName: ride.passenger_name,
      assignedDriverId: ride.assigned_driver_id,
      driver,
      tracking,
      pricing: ride.pricing,
      attempts: ride.attempts,
      origin: {
        lat: Number(ride.origin_lat),
        lng: Number(ride.origin_lng),
        label: ride.origin_label,
      },
      destination: {
        lat: Number(ride.dest_lat),
        lng: Number(ride.dest_lng),
        label: ride.dest_label,
      },
      updatedAt: new Date(ride.updated_at).getTime(),
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
});

app.post("/api/ride/:rideId/cancel", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM rides WHERE ride_id=$1`, [
      req.params.rideId,
    ]);
    if (!rows.length) return json(res, 404, { ok: false, error: "corrida_nao_encontrada" });
    const ride = rows[0];
    if (!["searching", "offered", "accepted"].includes(ride.status)) {
      return json(res, 400, { ok: false, error: "corrida_nao_pode_cancelar" });
    }

    const rt = ridesRuntime.get(ride.ride_id);
    if (rt?.timer) clearTimeout(rt.timer);

    if (ride.assigned_driver_id) {
      await pool.query(
        `UPDATE locations SET status='available' WHERE driver_id=$1`,
        [ride.assigned_driver_id]
      );
    }
    if (ride.offered_to) {
      await pool.query(
        `UPDATE locations SET status='available' WHERE driver_id=$1 AND status='busy'`,
        [ride.offered_to]
      );
    }

    await pool.query(
      `UPDATE rides SET status='cancelled', offered_to=NULL, updated_at=NOW() WHERE ride_id=$1`,
      [ride.ride_id]
    );

    await pool.query(
      `INSERT INTO client_stats (client_id, cancel_count, pending_fee)
       VALUES ($1, 1, 0)
       ON CONFLICT (client_id) DO UPDATE SET cancel_count = client_stats.cancel_count + 1`,
      [ride.client_id]
    );
    const st = await pool.query(
      `SELECT cancel_count, pending_fee FROM client_stats WHERE client_id=$1`,
      [ride.client_id]
    );
    let cancelCount = st.rows[0].cancel_count;
    let pendingFee = Number(st.rows[0].pending_fee);
    let feeCharged = 0;
    if (cancelCount > FREE_CANCEL_LIMIT) {
      feeCharged = CANCEL_FEE;
      pendingFee = Number((pendingFee + CANCEL_FEE).toFixed(2));
      await pool.query(
        `UPDATE client_stats SET pending_fee=$2 WHERE client_id=$1`,
        [ride.client_id, pendingFee]
      );
    }

    const msg =
      feeCharged > 0
        ? `Cancelada. Taxa de R$ ${feeCharged.toFixed(2)} será cobrada na próxima corrida.`
        : `Cancelada. Cancelamentos grátis restantes: ${Math.max(0, FREE_CANCEL_LIMIT - cancelCount)}.`;

    const notifyDrivers = new Set(
      [ride.offered_to, ride.assigned_driver_id].filter(Boolean)
    );
    for (const drv of notifyDrivers) {
      sendTo(driverSockets, drv, {
        type: "ride_cancelled",
        rideId: ride.ride_id,
        message: "Passageiro cancelou a corrida.",
      });
    }
    console.log("[CANCEL]", ride.ride_id, "by", ride.client_id, "drivers notified:", [...notifyDrivers]);

    notifyClient(ride.client_id, {
      type: "ride_cancelled",
      rideId: ride.ride_id,
      cancelCount,
      freeLeft: Math.max(0, FREE_CANCEL_LIMIT - cancelCount),
      feeCharged,
      pendingFee,
      message: msg,
    });

    return json(res, 200, {
      ok: true,
      rideId: ride.ride_id,
      status: "cancelled",
      cancelCount,
      freeLeft: Math.max(0, FREE_CANCEL_LIMIT - cancelCount),
      feeCharged,
      pendingFee,
      message: msg,
    });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: e.message });
  }
});

app.post("/api/ride/:rideId/finish", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM rides WHERE ride_id=$1`, [
      req.params.rideId,
    ]);
    if (!rows.length) return json(res, 404, { ok: false, error: "corrida_nao_encontrada" });
    const ride = rows[0];
    const rt = ridesRuntime.get(ride.ride_id);
    if (rt?.timer) clearTimeout(rt.timer);
    if (ride.assigned_driver_id) {
      await pool.query(
        `UPDATE locations SET status='available' WHERE driver_id=$1`,
        [ride.assigned_driver_id]
      );
    }
    await pool.query(
      `UPDATE rides SET status='finished', updated_at=NOW() WHERE ride_id=$1`,
      [ride.ride_id]
    );
    notifyClient(ride.client_id, { type: "ride_finished", rideId: ride.ride_id });
    return json(res, 200, { ok: true, rideId: ride.ride_id, status: "finished" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
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

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "ride_response") {
      try {
        const { rows } = await pool.query(`SELECT * FROM rides WHERE ride_id=$1`, [
          msg.rideId,
        ]);
        if (!rows.length) return;
        const ride = rows[0];
        if (ride.status !== "offered" || ride.offered_to !== msg.driverId) return;

        const rt = ridesRuntime.get(msg.rideId);
        if (rt?.timer) clearTimeout(rt.timer);

        if (msg.response === "accept") {
          await pool.query(
            `UPDATE rides SET status='accepted', assigned_driver_id=$2, offered_to=NULL, updated_at=NOW()
             WHERE ride_id=$1`,
            [msg.rideId, msg.driverId]
          );
          await pool.query(
            `UPDATE locations SET status='busy' WHERE driver_id=$1`,
            [msg.driverId]
          );

          const driver = await publicDriver(msg.driverId);
          let tracking = null;
          if (driver.lat != null) {
            const distM = haversineM(
              { lat: driver.lat, lng: driver.lng },
              { lat: Number(ride.origin_lat), lng: Number(ride.origin_lng) }
            );
            const eta = etaMinutes(distM / 1000);
            tracking = {
              distanceMeters: Math.round(distM),
              etaMinutes: eta,
              phase: distM <= ARRIVED_RADIUS_M ? "arrived" : "en_route",
              message:
                distM <= ARRIVED_RADIUS_M
                  ? "Seu motorista chegou!"
                  : `Motorista a caminho · aguarde ~${eta} min`,
            };
          }

          notifyClient(ride.client_id, {
            type: "ride_assigned",
            rideId: msg.rideId,
            driverId: msg.driverId,
            driver,
            pricing: ride.pricing,
            tracking,
          });
        } else {
          if (rt) rt.rejectedBy.add(msg.driverId);
          await pool.query(
            `UPDATE rides SET offered_to=NULL, status='searching', updated_at=NOW() WHERE ride_id=$1`,
            [msg.rideId]
          );
          offerNextDriver(msg.rideId);
        }
      } catch (e) {
        console.error("[WS] ride_response", e);
      }
    }
  });

  ws.on("close", () => {
    if (ws.driverId && driverSockets.get(ws.driverId) === ws) {
      driverSockets.delete(ws.driverId);
    }
    if (ws.clientId && clientSockets.get(ws.clientId) === ws) {
      clientSockets.delete(ws.clientId);
    }
  });
});

setInterval(() => {
  cleanExpired().catch(() => {});
}, 15000);

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[Rotas GO] V7.2 cancel fix + geo on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[DB] init failed", err);
    process.exit(1);
  });
