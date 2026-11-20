"use strict";

const $ = (id) => document.getElementById(id);
const parts = window.location.pathname.split("/").filter(Boolean);
const isVisitor = parts[0] === "share" && Boolean(parts[1]);
const shareToken = isVisitor ? parts[1] : null;
let ownerToken = null;
let analyticsTimer = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "تعذر إكمال الطلب.");
  return data;
}

function showError(message) {
  const box = $("ownerError");
  if (!box) return;
  box.textContent = message;
  box.classList.remove("hidden");
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

async function recordVisitOnce() {
  const key = "nard_visit_" + shareToken;
  if (sessionStorage.getItem(key)) return;
  const width = window.innerWidth || 0;
  const screen = width < 600 ? "small" : width < 1024 ? "medium" : "large";

  try {
    await api("/api/sessions/" + encodeURIComponent(shareToken) + "/visit", {
      method: "POST",
      body: JSON.stringify({
        userAgent: navigator.userAgent,
        language: navigator.language || "",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
        screen
      })
    });
    sessionStorage.setItem(key, "sent");
    setText("visitorStatus", "تم تسجيل بيانات الزيارة التقنية مرة واحدة.");
  } catch (error) {
    setText("visitorStatus", error.message);
  }
}

function renderVisits(data) {
  setText("visitTotal", String(data.total || 0));
  const topDevice = Object.entries(data.devices || {}).sort((a, b) => b[1] - a[1])[0];
  setText("visitDevices", topDevice ? topDevice[0] : "—");
  const countries = Object.keys(data.countries || {}).filter((value) => value !== "غير متاح");
  setText("visitCountries", countries.length ? String(countries.length) : "—");
  setText("analyticsUpdated", "آخر تحديث: " + new Date().toLocaleTimeString("ar"));

  const list = $("visitList");
  list.replaceChildren();
  if (!data.visits || !data.visits.length) {
    const empty = document.createElement("p");
    empty.className = "empty-visits";
    empty.textContent = "لا توجد زيارات مسجلة حتى الآن.";
    list.appendChild(empty);
    return;
  }

  data.visits.slice(0, 50).forEach((visit) => {
    const row = document.createElement("article");
    row.className = "visit-row";
    const main = document.createElement("div");
    main.className = "visit-main";
    const title = document.createElement("strong");
    title.textContent = [visit.device, visit.browser].filter(Boolean).join(" · ");
    const meta = document.createElement("span");
    meta.textContent = [visit.os, visit.language, visit.timezone, "الشاشة: " + visit.screen].filter(Boolean).join(" · ");
    main.append(title, meta);
    const side = document.createElement("div");
    side.className = "visit-side";
    const place = document.createElement("strong");
    place.textContent = [visit.city, visit.country].filter(Boolean).join("، ") || "الموقع التقريبي غير متاح";
    const time = document.createElement("span");
    time.textContent = new Date(visit.visitedAt).toLocaleString("ar");
    side.append(place, time);
    row.append(main, side);
    list.appendChild(row);
  });
}

async function loadAnalytics() {
  if (!ownerToken) return;
  try {
    const data = await api("/api/sessions/" + encodeURIComponent(ownerToken) + "/analytics");
    renderVisits(data);
  } catch (error) {
    setText("analyticsUpdated", error.message);
    if (/انتهت|غير موجودة/.test(error.message)) stopAnalyticsRefresh();
  }
}

function startAnalyticsRefresh() {
  stopAnalyticsRefresh();
  void loadAnalytics();
  analyticsTimer = setInterval(loadAnalytics, 5000);
}

function stopAnalyticsRefresh() {
  if (analyticsTimer) clearInterval(analyticsTimer);
  analyticsTimer = null;
}

async function createSession() {
  const button = $("createSession");
  $("ownerError").classList.add("hidden");
  button.disabled = true;
  button.textContent = "جارٍ إنشاء الرابط...";
  try {
    const data = await api("/api/sessions", { method: "POST", body: "{}" });
    ownerToken = data.ownerToken;
    sessionStorage.setItem("nard_owner_token", ownerToken);
    $("shareLink").value = data.shareUrl;
    setText("expiryText", "الرابط صالح لمدة " + data.ttlMinutes + " دقيقة.");
    $("ownerResult").classList.remove("hidden");
    button.classList.add("hidden");
    startAnalyticsRefresh();
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "إنشاء رابط زيارة";
  }
}

async function stopSession() {
  if (!ownerToken) return;
  stopAnalyticsRefresh();
  try {
    await api("/api/sessions/" + encodeURIComponent(ownerToken), { method: "DELETE" });
  } catch (_) {}
  sessionStorage.removeItem("nard_owner_token");
  ownerToken = null;
  $("ownerResult").classList.add("hidden");
  $("createSession").classList.remove("hidden");
  setText("analyticsUpdated", "تم إيقاف الرابط وحذف بيانات جلسته من الذاكرة.");
}

function initAdmin() {
  $("createSession").addEventListener("click", createSession);
  $("refreshAnalytics").addEventListener("click", loadAnalytics);
  $("stopSession").addEventListener("click", stopSession);
  $("copyLink").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("shareLink").value);
      $("copyLink").textContent = "تم النسخ";
      setTimeout(() => { $("copyLink").textContent = "نسخ"; }, 1500);
    } catch (_) {
      $("shareLink").select();
      document.execCommand("copy");
    }
  });

  const saved = sessionStorage.getItem("nard_owner_token");
  if (saved) {
    ownerToken = saved;
    $("ownerResult").classList.remove("hidden");
    $("createSession").classList.add("hidden");
    startAnalyticsRefresh();
  }
}

function initVisitor() {
  $("ownerPanel").classList.add("hidden");
  $("visitorPanel").classList.remove("hidden");
  void recordVisitOnce();
}

if (isVisitor) initVisitor();
else initAdmin();
