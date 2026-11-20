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
    lastLocation: null,
    analytics: []
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

// Store only coarse, consented visit metadata. Raw IP addresses and full user-agent strings are never saved.
function classifyVisitor(userAgent) {
  const ua = String(userAgent || "").slice(0, 500);
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /SamsungBrowser\//.test(ua) ? "Samsung Internet" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "متصفح غير معروف";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "غير معروف";
  const device = /Tablet|iPad/.test(ua) ? "Tablet" : /Mobile|Android|iPhone/.test(ua) ? "Mobile" : "Desktop";
  return { browser, os, device };
}
function safeHeader(value) {
  return typeof value === "string" ? value.replace(/[\\r\\n]/g, "").trim().slice(0, 80) : "";
}
app.post("/api/sessions/:shareToken/visit", (req, res) => {
  const session = findSession(req.params.shareToken, "shareToken");
  if (!session) return res.status(404).json({ error: "انتهت صلاحية رابط المشاركة." });
  const body = req.body || {};
  const { browser, os, device } = classifyVisitor(body.userAgent);
  const country = safeHeader(req.get("cf-ipcountry") || req.get("x-vercel-ip-country") || req.get("x-appengine-country"));
  const city = safeHeader(req.get("cf-ipcity") || req.get("x-vercel-ip-city"));
  const visit = {
    visitedAt: Date.now(),
    country: country && country !== "XX" ? country : null,
    city: city || null,
    browser,
    os,
    device,
    language: safeHeader(body.language),
    timezone: safeHeader(body.timezone),
    screen: ["small", "medium", "large"].includes(body.screen) ? body.screen : "unknown"
  };
  session.analytics.push(visit);
  if (session.analytics.length > 100) session.analytics.splice(0, session.analytics.length - 100);
  res.status(202).json({ ok: true });
});
app.get("/api/sessions/:ownerToken/analytics", (req, res) => {
  const session = findSession(req.params.ownerToken, "ownerToken");
  if (!session) return res.status(404).json({ error: "الجلسة غير موجودة أو انتهت صلاحيتها." });
  const visits = session.analytics.slice().reverse();
  const countBy = (key) => visits.reduce((acc, item) => {
    const value = item[key] || "غير متاح";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
  res.set("Cache-Control", "no-store, private");
  res.json({ total: visits.length, visits, devices: countBy("device"), countries: countBy("country") });
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
