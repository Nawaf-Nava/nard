"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TTL_MINUTES = Math.min(60, Math.max(5, Number(process.env.SESSION_TTL_MINUTES) || 30));
const SESSION_TTL_MS = TTL_MINUTES * 60 * 1000;
const sessions = new Map();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https://tile.openstreetmap.org"],
      connectSrc: ["'self'", "https://tile.openstreetmap.org"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null
    }
  },
  // OpenStreetMap requires a normal page Referer for its public tile service.
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));

app.use(express.json({ limit: "8kb" }));
app.use("/api/", (req, res, next) => {
  res.set("Cache-Control", "no-store, private");
  next();
});
app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));
app.use("/api/sessions", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));
app.use("/vendor/leaflet", express.static(path.join(__dirname, "node_modules", "leaflet", "dist"), { maxAge: "7d" }));
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  etag: true,
  maxAge: "7d",
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  }
}));

function token() {
  return crypto.randomBytes(32).toString("base64url");
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}
setInterval(cleanExpiredSessions, 60_000).unref();

function findSession(tokenValue, tokenType) {
  cleanExpiredSessions();
  for (const session of sessions.values()) {
    if (session[tokenType] === tokenValue) return session;
  }
  return null;
}

function validCoordinates(body) {
  if (!body || typeof body.latitude !== "number" || typeof body.longitude !== "number") return false;
  if (!Number.isFinite(body.latitude) || !Number.isFinite(body.longitude)) return false;
  if (body.latitude < -90 || body.latitude > 90) return false;
  if (body.longitude < -180 || body.longitude > 180) return false;
  return true;
}

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

app.post("/api/sessions", (req, res) => {
  cleanExpiredSessions();
  if (sessions.size >= 5000) {
    return res.status(503).json({ error: "الخدمة مشغولة حالياً. حاول لاحقاً." });
  }

  const id = crypto.randomUUID();
  const ownerToken = token();
  const shareToken = token();
  const now = Date.now();
  const session = {
    id,
    ownerToken,
    shareToken,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastLocation: null
  };
  sessions.set(id, session);

  const baseUrl = (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
  res.status(201).json({
    ownerToken,
    shareUrl: `${baseUrl}/share/${shareToken}`,
    expiresAt: new Date(session.expiresAt).toISOString(),
    ttlMinutes: TTL_MINUTES
  });
});

app.post("/api/sessions/:shareToken/location", (req, res) => {
  const session = findSession(req.params.shareToken, "shareToken");
  if (!session) return res.status(404).json({ error: "انتهت صلاحية رابط المشاركة أو تم إيقافه." });
  if (!validCoordinates(req.body)) {
    return res.status(400).json({ error: "إحداثيات الموقع غير صالحة." });
  }

  session.lastLocation = {
    latitude: req.body.latitude,
    longitude: req.body.longitude,
    accuracy: Number.isFinite(req.body.accuracy) ? Math.min(100000, Math.max(0, req.body.accuracy)) : null,
    updatedAt: Date.now()
  };
  res.status(202).json({ ok: true });
});

app.get("/api/sessions/:ownerToken", (req, res) => {
  const session = findSession(req.params.ownerToken, "ownerToken");
  if (!session) return res.status(404).json({ error: "الجلسة غير موجودة أو انتهت صلاحيتها." });

  res.json({
    location: session.lastLocation,
    expiresAt: new Date(session.expiresAt).toISOString(),
    remainingMs: Math.max(0, session.expiresAt - Date.now())
  });
});

app.delete("/api/sessions/:ownerToken", (req, res) => {
  const session = findSession(req.params.ownerToken, "ownerToken");
  if (!session) return res.status(404).json({ error: "الجلسة غير موجودة أو انتهت صلاحيتها." });
  sessions.delete(session.id);
  res.json({ ok: true });
});

app.get("/share/:shareToken", (req, res) => {
  const session = findSession(req.params.shareToken, "shareToken");
  if (!session) return res.status(404).sendFile(path.join(__dirname, "public", "expired.html"));
  res.set("Cache-Control", "no-store, private");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", (req, res) => {
  res.set("Cache-Control", "no-store, private");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/", (req, res) => res.redirect(302, "/admin"));

app.use((req, res) => {
  res.status(404).send("Not found");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`GeoLink listening on port ${PORT}`);
});
