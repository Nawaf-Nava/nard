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

function setupMap(latitude, longitude, accuracy) {
  if (!window.L) {
    $("locationDetails").textContent = "تعذر تحميل الخريطة. الإحداثيات وصلت إلى الجلسة.";
    return;
  }
  if (!map) {
    map = L.map("map", { scrollWheelZoom: false }).setView([latitude, longitude], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap"
    }).addTo(map);
  }
  const point = [latitude, longitude];
  if (!marker) marker = L.marker(point).addTo(map);
  else marker.setLatLng(point);
  if (!accuracyCircle) accuracyCircle = L.circle(point, { radius: accuracy || 0, color: "#55a7ff", fillOpacity: 0.08 }).addTo(map);
  else accuracyCircle.setLatLng(point).setRadius(accuracy || 0);
  map.setView(point, Math.max(map.getZoom(), 14));
  $("locationDetails").textContent =
    `خط العرض: ${latitude.toFixed(5)} | خط الطول: ${longitude.toFixed(5)} | دقة تقريبية: ${Math.round(accuracy || 0)} متر`;
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
    await pollOwnerSession();
    pollTimer = setInterval(pollOwnerSession, 4000);
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

  const savedToken = sessionStorage.getItem("geolink_owner_token");
  if (savedToken) {
    ownerToken = savedToken;
    $("ownerResult").classList.remove("hidden");
    $("createSession").classList.add("hidden");
    // The owner token is intentionally kept only in this browser tab's session storage.
    pollOwnerSession().then(() => {
      if (ownerToken) pollTimer = setInterval(pollOwnerSession, 4000);
    });
  }
}

function setParticipantStatus(message, isError = false) {
  const el = $("participantStatus");
  el.textContent = message;
  el.style.color = isError ? "#ff9eaa" : "";
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

function initParticipant() {
  $("ownerPanel").classList.add("hidden");
  $("participantPanel").classList.remove("hidden");
  $("startSharing").addEventListener("click", () => {
    if (!navigator.geolocation) {
      setParticipantStatus("المتصفح لا يدعم تحديد الموقع.", true);
      return;
    }
    if (!window.isSecureContext) {
      setParticipantStatus("يلزم فتح الرابط عبر HTTPS حتى يعمل تحديد الموقع.", true);
      return;
    }
    stopped = false;
    $("startSharing").disabled = true;
    setParticipantStatus("بانتظار إذن الموقع من المتصفح...");
    watchId = navigator.geolocation.watchPosition(
      sendLocation,
      (error) => {
        const messages = {
          1: "لم تمنح إذن الموقع. لم تتم مشاركة أي إحداثيات.",
          2: "تعذر تحديد الموقع حالياً.",
          3: "انتهت مهلة تحديد الموقع. حاول مجدداً."
        };
        setParticipantStatus(messages[error.code] || "تعذر الوصول إلى الموقع.", true);
        $("startSharing").disabled = false;
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
    $("startSharing").classList.add("hidden");
    $("startSharing").disabled = false;
    $("stopSharing").classList.remove("hidden");
  });
  $("stopSharing").addEventListener("click", stopParticipantSharing);
  window.addEventListener("pagehide", () => {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
  });
}

if (isParticipant) initParticipant();
else initOwner();