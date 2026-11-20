"use strict";

const $ = (id) => document.getElementById(id);
const pathParts = window.location.pathname.split("/").filter(Boolean);
const isParticipant = pathParts[0] === "share" && Boolean(pathParts[1]);
const shareToken = isParticipant ? pathParts[1] : null;
let ownerToken = null;
let pollTimer = null;
let map = null;
let marker = null;
let accuracyCircle = null;
let latestPoint = null;
let watchId = null;
let stopped = false;

function showError(message) {
  const box = $("ownerError");
  if (!box) return;
  box.textContent = message;
  box.classList.remove("hidden");
}
function clearError() {
  const box = $("ownerError");
  if (box) box.classList.add("hidden");
}
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

function initializeMap() {
  if (!window.L) {
    const details = $("locationDetails");
    if (details) details.textContent = "تعذر تحميل مكتبة الخريطة المحلية. أعد تحميل الصفحة.";
    return false;
  }
  if (!map) {
    map = L.map("map", {
      scrollWheelZoom: true,
      zoomControl: true,
      preferCanvas: true
    }).setView([20, 0], 2);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      minZoom: 2,
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
    }).addTo(map);
  }
  requestAnimationFrame(() => map && map.invalidateSize());
  return true;
}

function setupMap(latitude, longitude, accuracy) {
  if (!initializeMap()) return;
  const point = [latitude, longitude];
  latestPoint = point;
  if (!marker) {
    marker = L.marker(point, { title: "آخر موقع تمت مشاركته" }).addTo(map);
    marker.bindPopup("آخر موقع تمت مشاركته");
  } else {
    marker.setLatLng(point);
  }
  if (!accuracyCircle) {
    accuracyCircle = L.circle(point, {
      radius: accuracy || 0,
      color: "#55a7ff",
      weight: 1.5,
      fillColor: "#55a7ff",
      fillOpacity: 0.12
    }).addTo(map);
  } else {
    accuracyCircle.setLatLng(point).setRadius(accuracy || 0);
  }
  map.setView(point, Math.max(map.getZoom(), 15));
  $("recenterMap").disabled = false;
  $("openMap").href = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
  $("locationDetails").textContent =
    `خط العرض: ${latitude.toFixed(5)} | خط الطول: ${longitude.toFixed(5)} | دقة تقريبية: ${Math.round(accuracy || 0)} متر`;
  requestAnimationFrame(() => map && map.invalidateSize());
}

function centerMap() {
  if (map && latestPoint) map.setView(latestPoint, 16, { animate: true });
}

async function toggleFullscreen() {
  const frame = $("mapFrame");
  try {
    if (!document.fullscreenElement) await frame.requestFullscreen();
    else await document.exitFullscreen();
    setTimeout(() => map && map.invalidateSize(), 150);
  } catch (_) {
    showError("تعذر تفعيل وضع ملء الشاشة في هذا المتصفح.");
  }
}

async function pollOwnerSession() {
  if (!ownerToken) return;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(ownerToken)}`);
    if (data.location) {
      const loc = data.location;
      setupMap(loc.latitude, loc.longitude, loc.accuracy);
      $("locationStatus").textContent = "تم استلام الموقع · " + new Date(loc.updatedAt).toLocaleTimeString("ar");
    } else {
      $("locationStatus").textContent = "بانتظار موافقة الشخص";
    }
    const remaining = Math.max(0, Math.ceil(data.remainingMs / 60000));
    $("expiryText").textContent = `تنتهي الجلسة خلال نحو ${remaining} دقيقة.`;
    if (remaining <= 0) stopPolling();
  } catch (error) {
    $("locationStatus").textContent = error.message;
    stopPolling();
  }
}
async function loadAnalytics() {
  if (!ownerToken) return;
  const button = $("refreshAnalytics");
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(ownerToken)}/analytics`);
    $("visitTotal").textContent = String(data.total || 0);
    const topDevice = Object.entries(data.devices || {}).sort((a,b) => b[1]-a[1])[0];
    $("visitDevices").textContent = topDevice ? topDevice[0] : "—";
    const countryCount = Object.keys(data.countries || {}).filter(x => x !== "غير متاح").length;
    $("visitCountries").textContent = countryCount ? String(countryCount) : "—";
    $("analyticsUpdated").textContent = "آخر تحديث: " + new Date().toLocaleTimeString("ar");
    const list = $("visitList");
    list.replaceChildren();
    if (!data.visits || !data.visits.length) {
      const empty = document.createElement("p");
      empty.className = "empty-visits";
      empty.textContent = "لا توجد زيارات بموافقة الزائر حتى الآن.";
      list.appendChild(empty);
    } else {
      data.visits.slice(0, 20).forEach((visit) => {
        const row = document.createElement("article");
        row.className = "visit-row";
        const main = document.createElement("div");
        main.className = "visit-main";
        const title = document.createElement("strong");
        title.textContent = [visit.device, visit.browser].filter(Boolean).join(" · ");
        const meta = document.createElement("span");
        meta.textContent = [visit.os, visit.language, visit.timezone].filter(Boolean).join(" · ") || "تفاصيل إضافية غير متاحة";
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
  } catch (error) {
    $("analyticsUpdated").textContent = error.message;
  } finally {
    if (button) button.disabled = false;
  }
}

async function recordVisitAnalytics() {
  const key = `geolink_analytics_${shareToken}`;
  if (sessionStorage.getItem(key)) return;
  try {
    const width = window.innerWidth || 0;
    const screenClass = width < 600 ? "small" : width < 1024 ? "medium" : "large";
    await api(`/api/sessions/${encodeURIComponent(shareToken)}/visit`, {
      method: "POST",
      body: JSON.stringify({
        userAgent: navigator.userAgent,
        language: navigator.language || "",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
        screen: screenClass
      })
    });
    sessionStorage.setItem(key, "sent");
  } catch (_) {
    // Analytics are optional and must never interrupt location sharing.
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function createSession() {
  clearError();
  const button = $("createSession");
  button.disabled = true;
  button.textContent = "جارٍ إنشاء الرابط...";
  try {
    const data = await api("/api/sessions", { method: "POST", body: "{}" });
    ownerToken = data.ownerToken;
    sessionStorage.setItem("geolink_owner_token", ownerToken);
    $("shareLink").value = data.shareUrl;
    $("expiryText").textContent = `الرابط صالح لمدة ${data.ttlMinutes} دقيقة.`;
    $("ownerResult").classList.remove("hidden");
    $("createSession").classList.add("hidden");
    initializeMap();
    await pollOwnerSession();
    await loadAnalytics();
    pollTimer = setInterval(pollOwnerSession, 5000);
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = 'إنشاء رابط مشاركة <span>↗</span>';
  }
}

async function stopOwnerSession() {
  if (!ownerToken) return;
  stopPolling();
  try {
    await api(`/api/sessions/${encodeURIComponent(ownerToken)}`, { method: "DELETE" });
  } catch (_) {}
  sessionStorage.removeItem("geolink_owner_token");
  ownerToken = null;
  latestPoint = null;
  $("ownerResult").classList.add("hidden");
  $("createSession").classList.remove("hidden");
  $("locationStatus").textContent = "تم إيقاف الجلسة";
}

function initOwner() {
  $("participantPanel").classList.add("hidden");
  $("ownerPanel").classList.remove("hidden");
  $("createSession").addEventListener("click", createSession);
  $("copyLink").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("shareLink").value);
      $("copyLink").textContent = "تم النسخ";
      setTimeout(() => $("copyLink").textContent = "نسخ", 1600);
    } catch (_) {
      $("shareLink").select();
      document.execCommand("copy");
    }
  });
  $("stopSession").addEventListener("click", stopOwnerSession);
  $("refreshAnalytics").addEventListener("click", loadAnalytics);
  $("recenterMap").addEventListener("click", centerMap);
  $("fullscreenMap").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", () => setTimeout(() => map && map.invalidateSize(), 100));

  const savedToken = sessionStorage.getItem("geolink_owner_token");
  if (savedToken) {
    ownerToken = savedToken;
    $("ownerResult").classList.remove("hidden");
    $("createSession").classList.add("hidden");
    initializeMap();
    pollOwnerSession().then(async () => {
      if (ownerToken) {
        await loadAnalytics();
        pollTimer = setInterval(pollOwnerSession, 5000);
      }
    });
  }
}

function setParticipantStatus(message, isError = false) {
  const el = $("participantStatus");
  el.textContent = message;
  el.classList.toggle("status-error", isError);
}

async function sendLocation(position) {
  if (stopped) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(shareToken)}/location`, {
      method: "POST",
      body: JSON.stringify({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy
      })
    });
    setParticipantStatus("موقعك يُشارك الآن. يمكنك إيقاف المشاركة في أي وقت.");
  } catch (error) {
    setParticipantStatus(error.message, true);
    stopParticipantSharing();
  }
}

function stopParticipantSharing() {
  stopped = true;
  if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  $("startSharing").classList.remove("hidden");
  $("stopSharing").classList.add("hidden");
  setParticipantStatus("تم إيقاف مشاركة الموقع من هذه الصفحة.");
}

function startParticipantSharing() {
  if (!navigator.geolocation) {
    setParticipantStatus("المتصفح لا يدعم تحديد الموقع.", true);
    $("startSharing").classList.remove("hidden");
    return;
  }
  if (!window.isSecureContext) {
    setParticipantStatus("يلزم فتح الرابط عبر HTTPS حتى يعمل تحديد الموقع.", true);
    $("startSharing").classList.remove("hidden");
    return;
  }
  if (watchId !== null) return;

  stopped = false;
  $("startSharing").classList.add("hidden");
  $("stopSharing").classList.remove("hidden");
  setParticipantStatus("يطلب GeoLink إذن الموقع من المتصفح. لن يُرسل موقعك ما لم تسمح بذلك...");
  watchId = navigator.geolocation.watchPosition(
    (position) => { void sendLocation(position); },
    (error) => {
      const messages = {
        1: "لم تمنح إذن الموقع. لم تتم مشاركة أي إحداثيات. يمكنك تغيير الإذن من إعدادات المتصفح.",
        2: "تعذر تحديد الموقع حالياً.",
        3: "انتهت مهلة تحديد الموقع. يمكنك المحاولة مجدداً."
      };
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      setParticipantStatus(messages[error.code] || "تعذر الوصول إلى الموقع.", true);
      $("startSharing").classList.remove("hidden");
      $("stopSharing").classList.add("hidden");
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
  );
}

function initParticipant() {
  $("ownerPanel").classList.add("hidden");
  $("participantPanel").classList.remove("hidden");
  $("startSharing").addEventListener("click", startParticipantSharing);
  $("stopSharing").addEventListener("click", stopParticipantSharing);
  $("acceptAnalytics").addEventListener("click", async () => {
    $("analyticsConsent").classList.add("hidden");
    sessionStorage.setItem(`geolink_analytics_choice_${shareToken}`, "accepted");
    await recordVisitAnalytics();
  });
  $("rejectAnalytics").addEventListener("click", () => {
    $("analyticsConsent").classList.add("hidden");
    sessionStorage.setItem(`geolink_analytics_choice_${shareToken}`, "rejected");
  });
  const analyticsChoice = sessionStorage.getItem(`geolink_analytics_choice_${shareToken}`);
  if (analyticsChoice === "accepted") void recordVisitAnalytics();
  if (analyticsChoice === "rejected") $("analyticsConsent").classList.add("hidden");
  window.addEventListener("pagehide", () => {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  });

  // The share page is an explicit request. The browser still owns the permission prompt.
  startParticipantSharing();
}

if (isParticipant) initParticipant();
else initOwner();
