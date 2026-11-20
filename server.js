"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
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
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null
    }
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));

app.use(express.json({ limit: "8kb" }));
app.use("/api/", (_req, res, next) => {
  res.set("Cache-Control", "no-store, private");
  next();
});
app.use("/api/", rateLimit({
  windowMs: 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false
}));
const createSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false
});

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

function safeText(value, max = 100) {
  return typeof value === "string" ? value.replace(/[\r\n<>]/g, "").trim().slice(0, max) : "";
}

function maskedIp(ip) {
  if (net.isIP(ip) === 4) {
    const parts = ip.split(".");
    parts[3] = "x";
    return parts.join(".");
  }
  if (net.isIP(ip) === 6) return ip.split(":").slice(0, 3).join(":") + ":…";
  return "غير متاح";
}

function classifyVisitor(userAgent) {
  const ua = String(userAgent || "").slice(0, 500);
  const browserMatch = ua.match(/(Edg|Firefox|SamsungBrowser|Chrome|CriOS|Version|Safari)\/([\d.]+)/);
  const browserName = browserMatch
    ? ({ Edg: "Edge", Firefox: "Firefox", SamsungBrowser: "Samsung Internet", Chrome: "Chrome", CriOS: "Chrome iOS", Version: "Safari", Safari: "Safari" }[browserMatch[1]] || "متصفح")
    : "متصفح غير معروف";
  const osMatch = ua.match(/(Android|iPhone OS|iOS|Windows NT|Mac OS X|Linux)[\s/]*([\d._]*)/);
  const osName = /Android/.test(ua) ? "Android"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "غير معروف";
  const device = /iPad|Tablet/.test(ua) ? "Tablet"
    : /Mobile|Android|iPhone/.test(ua) ? "Mobile"
    : "Desktop";
  return {
    browser: browserMatch ? browserName + " " + browserMatch[2] : browserName,
    os: osMatch ? osName + (osMatch[2] ? " " + osMatch[2].replace(/_/g, ".") : "") : osName,
    device
  };
}

async function lookupIp(ip) {
  if (!ip || !net.isIP(ip) || /^(127\.|10\.|192\.168\.|169\.254\.|::1$|fc|fd|fe80:)/i.test(ip)) return null;
  try {
    const response = await fetch("https://ipwho.is/" + encodeURIComponent(ip), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || data.success !== true) return null;
    const connection = data.connection || {};
    const timezone = data.timezone || {};
    const flag = data.flag || {};
    return {
      country: safeText(data.country),
      countryCode: safeText(data.country_code, 2).toUpperCase(),
      flag: safeText(flag.emoji, 8),
      region: safeText(data.region),
      city: safeText(data.city),
      isp: safeText(connection.isp),
      organization: safeText(connection.org),
      asn: connection.asn ? "AS" + String(connection.asn).replace(/^AS/i, "") : "",
      connectionType: safeText(connection.connection_type),
      ipTimezone: safeText(timezone.id || timezone.utc),
      accuracy: "تقدير تقريبي من قاعدة بيانات IP",
      mapQuery: [data.city, data.region, data.country].filter(Boolean).join(", ")
    };
  } catch (_) {
    return null;
  }
}

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  etag: true,
  maxAge: "7d",
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    }
  }
}));

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

app.post("/api/sessions", createSessionLimiter, (req, res) => {
  cleanExpiredSessions();
  if (sessions.size >= 5000) {
    return res.status(503).json({ error: "الخدمة مشغولة حالياً. حاول لاحقاً." });
  }

  const id = crypto.randomUUID();
  const ownerToken = token();
  const shareToken = token();
  const now = Date.now();
  const session = { id, ownerToken, shareToken, createdAt: now, expiresAt: now + SESSION_TTL_MS, analytics: [] };
  sessions.set(id, session);

  const baseUrl = (process.env.BASE_URL || (req.protocol + "://" + req.get("host"))).replace(/\/$/, "");
  res.status(201).json({
    ownerToken,
    shareUrl: baseUrl + "/share/" + shareToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
    ttlMinutes: TTL_MINUTES
  });
});

// Anonymous page-view counter: stores only a timestamp, never visitor identifiers or location data.
app.post("/api/sessions/:shareToken/view", (req, res) => {
  const session = findSession(req.params.shareToken, "shareToken");
  if (!session) return res.status(404).json({ error: "انتهت صلاحية رابط الزيارة." });
  if (session.analytics.length >= 100) {
    return res.status(429).json({ error: "وصلت الجلسة إلى حد الزيارات المسجلة." });
  }
  session.analytics.push({ visitedAt: Date.now(), anonymous: true });
  res.status(202).json({ ok: true });
});

// A visit is stored only after the visitor explicitly accepts the notice.
// The raw IP is used transiently for city-level enrichment, then discarded.
app.post("/api/sessions/:shareToken/visit", async (req, res) => {
  const session = findSession(req.params.shareToken, "shareToken");
  if (!session) return res.status(404).json({ error: "انتهت صلاحية رابط الزيارة." });
  if (!req.body || req.body.consent !== true) {
    return res.status(400).json({ error: "يلزم قبول إشعار البيانات قبل التسجيل." });
  }
  if (session.analytics.length >= 100) {
    return res.status(429).json({ error: "وصلت الجلسة إلى حد الزيارات المحفوظة." });
  }

  const ip = String(req.ip || "").replace(/^::ffff:/, "");
  const location = await lookupIp(ip);
  const { browser, os, device } = classifyVisitor(req.body.userAgent);
  const referrer = (() => {
    try { return new URL(String(req.body.referrer || "")).hostname.slice(0, 120); }
    catch (_) { return ""; }
  })();

  const visit = {
    visitedAt: Date.now(),
    ipMasked: maskedIp(ip),
    country: location ? location.country : "",
    countryCode: location ? location.countryCode : "",
    flag: location ? location.flag : "",
    region: location ? location.region : "",
    city: location ? location.city : "",
    isp: location ? location.isp : "",
    organization: location ? location.organization : "",
    asn: location ? location.asn : "",
    connectionType: location ? location.connectionType : "",
    ipTimezone: location ? location.ipTimezone : "",
    accuracy: location ? location.accuracy : "بيانات الموقع غير متاحة",
    mapQuery: location ? location.mapQuery : "",
    browser,
    os,
    device,
    language: safeText(req.body.language, 40),
    timezone: safeText(req.body.timezone, 80),
    screen: ["small", "medium", "large"].includes(req.body.screen) ? req.body.screen : "unknown",
    referrer
  };

  session.analytics.push(visit);
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
  res.json({
    total: visits.length,
    visits,
    devices: countBy("device"),
    countries: countBy("country"),
    browsers: countBy("browser"),
    providers: countBy("isp")
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
  if (!session) return res.status(404).send("انتهت صلاحية هذا الرابط.");
  res.set("Cache-Control", "no-store, private");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/admin", (_req, res) => {
  res.set("Cache-Control", "no-store, private");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/", (_req, res) => res.redirect(302, "/admin"));
app.use((_req, res) => res.status(404).send("Not found"));

app.listen(PORT, "0.0.0.0", () => {
  console.log("NARD listening on port " + PORT);
});
