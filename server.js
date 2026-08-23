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
const ARRIVED_RADIUS_M = Number(process.env.ARRIVED_RADIUS_M || 120);

// SEGURANÇA: sem fallback com senha
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL não configurado no.env / Render");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === "0"? false : { rejectUnauthorized: false },
  max: 5,
});

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const safe = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)? ext : ".jpg";
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

const ridesRuntime = new Map();
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
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function haversineM(a, b) { return haversineKm(a, b) * 1000; }

const SERVICE_PRICING = {
  ride: { pricePerKm: 2.0, appFee: 0.8, label: "Motorista" },
  delivery: { pricePerKm: 1.2, appFee: 0.6, label: "Entrega" },
};
function getServicePricing(t) { return SERVICE_PRICING[t] || SERVICE_PRICING.ride; }
function calcPrice(distanceKm, serviceType = "ride") {
  const cfg = getServicePricing(serviceType);
  const ride = Number((distanceKm * cfg.pricePerKm).toFixed(2));
  const total = Number((ride + cfg.appFee).toFixed(2));
  return { serviceType, serviceLabel: cfg.label, distanceKm: Number(distanceKm.toFixed(2)), pricePerKm: cfg.pricePerKm, ridePrice: ride, appFee: cfg.appFee, total };
}
function etaMinutes(distanceKm) {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 1;
  return Math.max(1, Math.round((distanceKm / 25) * 60));
}
function sendTo(socketMap, id, payload) {
  const ws = socketMap.get(id);
  if (ws && ws.readyState === ws.OPEN) { ws.send(JSON.stringify(payload)); return true; }
  return false;
}
function notifyClient(clientId, payload) { sendTo(clientSockets, clientId, payload); }
async function cleanExpired() { await pool.query(`DELETE FROM locations WHERE expires_at <= NOW()`); }

async function publicDriver(driverId) {
  const { rows } = await pool.query(`SELECT d.driver_id, d.name, d.plate, d.model, d.color, d.photo_url, l.lat, l.lng, l.accuracy, l.status, l.updated_at FROM drivers d LEFT JOIN locations l ON l.driver_id = d.driver_id AND l.expires_at > NOW() WHERE d.driver_id = $1`, [driverId]);
  if (!rows.length) return { driverId, name: driverId, plate: null, model: null, color: null, photoUrl: null, lat: null, lng: null, accuracy: null, status: "offline", ageSeconds: null };
  const r = rows[0];
  return { driverId: r.driver_id, name: r.name || driverId, plate: r.plate, model: r.model, color: r.color, photoUrl: r.photo_url, lat: r.lat!= null? Number(r.lat) : null, lng: r.lng!= null? Number(r.lng) : null, accuracy: r.accuracy!= null? Number(r.accuracy) : null, status: r.status || (r.lat!= null? "available" : "offline"), ageSeconds: r.updated_at!= null? Math.round((Date.now() - new Date(r.updated_at).getTime()) / 1000) : null };
}
async function listOnlineDrivers() {
  const { rows } = await pool.query(`SELECT d.driver_id, d.name, d.plate, d.model, d.color, d.photo_url, l.lat, l.lng, l.accuracy, l.status, l.updated_at FROM locations l JOIN drivers d ON d.driver_id = l.driver_id WHERE l.expires_at > NOW() ORDER BY l.updated_at DESC`);
  return rows.map((r) => ({ driverId: r.driver_id, name: r.name, plate: r.plate, model: r.model, color: r.color, photoUrl: r.photo_url, lat: Number(r.lat), lng: Number(r.lng), accuracy: r.accuracy!= null? Number(r.accuracy) : null, status: r.status || "available", ageSeconds: Math.round((Date.now() - new Date(r.updated_at).getTime()) / 1000) }));
}

// Health
app.get("/health", async (_req, res) => {
  let dbOk = false, activeDrivers = 0;
  try { await pool.query("SELECT 1"); dbOk = true; const r = await pool.query(`SELECT COUNT(*)::int AS c FROM locations WHERE expires_at > NOW()`); activeDrivers = r.rows[0].c; } catch (e) { console.error("[DB] health", e.message); }
  res.json({ ok: true, service: "rotas-go-rides", version: "7.3-secure", db: dbOk, activeDrivers, pricing: SERVICE_PRICING, timestamp: new Date().toISOString() });
});

// REVERSE GEOCODE - novo
app.get("/api/geocode/reverse", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) ||!Number.isFinite(lng)) return json(res, 400, { ok: false, error: "lat_lng_obrigatorio" });
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const r = await fetch(url, { headers: { "User-Agent": "RotasGO/1.0" } });
    const data = await r.json();
    return json(res, 200, { ok: true, lat, lng, address: data.display_name, details: data.address, raw: data });
  } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
});

// Upload
app.post("/api/upload/photo", (req, res) => {
  upload.single("photo")(req, res, (err) => {
    if (err) return json(res, 400, { ok: false, error: err.message || "upload_falhou" });
    if (!req.file) return json(res, 400, { ok: false, error: "arquivo_obrigatorio" });
    return json(res, 200, { ok: true, photoUrl: `/uploads/${req.file.filename}`, size: req.file.size, mime: req.file.mimetype });
  });
});

// Driver profile + location (mantive igual, só tirei duplicidade)
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
    await pool.query(`INSERT INTO drivers (driver_id, name, plate, model, color, photo_url, updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (driver_id) DO UPDATE SET name=EXCLUDED.name, plate=EXCLUDED.plate, model=EXCLUDED.model, color=EXCLUDED.color, photo_url=COALESCE(EXCLUDED.photo_url, drivers.photo_url), updated_at=NOW()`, [driverId, name, plate, model, color, photoUrl]);
    return json(res, 200, { ok: true, profile: { driverId, name, plate, model, color, photoUrl } });
  } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
});

app.post("/api/location/update", async (req, res) => {
  try {
    const driverId = String(req.body?.driverId || "").trim();
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const accuracy = req.body?.accuracy!= null? Number(req.body.accuracy) : null;
    if (!driverId) return json(res, 400, { ok: false, error: "driverId_obrigatorio" });
    if (!Number.isFinite(lat) ||!Number.isFinite(lng)) return json(res, 400, { ok: false, error: "coordenadas_invalidas" });
    await pool.query(`INSERT INTO drivers (driver_id, name, updated_at) VALUES ($1,$1,NOW()) ON CONFLICT (driver_id) DO NOTHING`, [driverId]);
    const prev = await pool.query(`SELECT status FROM locations WHERE driver_id=$1`, [driverId]);
    const status = prev.rows[0]?.status === "busy"? "busy" : "available";
    const expiresAt = new Date(Date.now() + LOCATION_TTL_MS);
    await pool.query(`INSERT INTO locations (driver_id, lat, lng, accuracy, status, updated_at, expires_at) VALUES ($1,$2,$3,$4,$5,NOW(),$6) ON CONFLICT (driver_id) DO UPDATE SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, accuracy=EXCLUDED.accuracy, status=CASE WHEN locations.status='busy' THEN 'busy' ELSE EXCLUDED.status END, updated_at=NOW(), expires_at=EXCLUDED.expires_at`, [driverId, lat, lng, accuracy, status, expiresAt]);
    return json(res, 200, { ok: true, location: { driverId, lat, lng, accuracy, status } });
  } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
});

//... resto do teu código de ride/estimate/request/cancel/finish continua igual
// por tamanho, mantém o mesmo que tu já tinha a partir daqui

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws, req) => {
  let role = null, id = null;
  try { const url = new URL(req.url, "http://localhost"); role = url.searchParams.get("role"); id = url.searchParams.get("id"); } catch {}
  if (role === "driver" && id) driverSockets.set(id, ws);
  else if (role === "client" && id) clientSockets.set(id, ws);
  ws.on("close", () => {
    if (id && driverSockets.get(id) === ws) driverSockets.delete(id);
    if (id && clientSockets.get(id) === ws) clientSockets.delete(id);
  });
});

setInterval(() => { cleanExpired().catch(() => {}); }, 15000);
initDb().then(() => { server.listen(PORT, () => console.log(`[Rotas GO] V7.3 secure on ${PORT}`)); }).catch((err) => { console.error("[DB] init failed", err); process.exit(1); });
