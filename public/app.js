"use strict";

const $ = (id) => document.getElementById(id);
const parts = window.location.pathname.split("/").filter(Boolean);
const isVisitor = parts[0] === "share" && Boolean(parts[1]);
const shareToken = isVisitor ? parts[1] : null;
let ownerToken = null;
let analyticsTimer = null;
let latestAnalytics = { total: 0, visits: [] };

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

function mapSearchUrl(query) {
  return "https://www.openstreetmap.org/search?query=" + encodeURIComponent(query);
}

async function recordConsentVisit() {
  const button = $("consentAccept");
  button.disabled = true;
  button.textContent = "جارٍ تسجيل البيانات بموافقتك...";
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const width = window.innerWidth;
    const screen = width < 600 ? "small" : width < 1100 ? "medium" : "large";
    await api("/api/sessions/" + encodeURIComponent(shareToken) + "/visit", {
      method: "POST",
      body: JSON.stringify({
        consent: true,
        language: navigator.language || "",
        timezone,
        screen
      })
    });
    setText("visitorStatus", "تم تسجيل بيانات الزيارة التي وافقت على مشاركتها. يمكنك إغلاق الصفحة الآن.");
    $("consentActions").classList.add("hidden");
  } catch (error) {
    setText("visitorStatus", error.message);
    $("visitorStatus").classList.add("status-error");
    button.disabled = false;
    button.textContent = "أوافق وأشارك بيانات الزيارة";
  }
}

async function recordAnonymousVisit() {
  const button = $("consentDecline");
  button.disabled = true;
  try {
    await api("/api/sessions/" + encodeURIComponent(shareToken) + "/view", {
      method: "POST",
      body: "{}"
    });
    setText("visitorStatus", "تم تسجيل وقت المشاهدة فقط. لم تُجمع بيانات الشبكة أو الجهاز أو الموقع.");
    $("consentActions").classList.add("hidden");
  } catch (error) {
    setText("visitorStatus", error.message);
    $("visitorStatus").classList.add("status-error");
    button.disabled = false;
  }
}

function addDetail(parent, label, value) {
  if (!value) return;
  const line = document.createElement("div");
  line.className = "visit-detail";
  const name = document.createElement("span");
  name.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value;
  line.append(name, content);
  parent.appendChild(line);
}

function renderVisits(data) {
  latestAnalytics = data || { total: 0, visits: [] };
  const visits = Array.isArray(data.visits) ? data.visits : [];
  setText("visitTotal", String(data.total || 0));
  const topDevice = Object.entries(data.devices || {}).sort((a, b) => b[1] - a[1])[0];
  setText("visitDevices", topDevice ? topDevice[0] : "—");
  const countries = Object.keys(data.countries || {}).filter((value) => value !== "غير متاح");
  setText("visitCountries", countries.length ? String(countries.length) : "—");
  const providers = Object.entries(data.providers || {}).filter(([name]) => name !== "غير متاح").length;
  setText("visitProviders", providers ? String(providers) : "—");
  setText("analyticsUpdated", "آخر تحديث: " + new Date().toLocaleTimeString("ar"));

  const list = $("visitList");
  list.replaceChildren();
  if (!visits.length) {
    const empty = document.createElement("p");
    empty.className = "empty-visits";
    empty.textContent = "لا توجد زيارات مسجلة حتى الآن.";
    list.appendChild(empty);
    return;
  }

  visits.slice(0, 50).forEach((visit) => {
    const row = document.createElement("article");
    row.className = "visit-row";
    const heading = document.createElement("div");
    heading.className = "visit-row-heading";
    const title = document.createElement("strong");
    title.textContent = visit.anonymous ? "مشاهدة مجهولة، دون بيانات شخصية" : ([visit.flag, visit.city, visit.region, visit.country].filter(Boolean).join(" · ") || "الموقع التقريبي غير متاح");
    const time = document.createElement("span");
    time.textContent = new Date(visit.visitedAt).toLocaleString("ar");
    heading.append(title, time);

    const grid = document.createElement("div");
    grid.className = "visit-details-grid";
    addDetail(grid, "عنوان IP المحجوب", visit.ipMasked);
    addDetail(grid, "مزود الإنترنت", visit.isp);
    addDetail(grid, "المؤسسة", visit.organization);
    addDetail(grid, "ASN", visit.asn);
    addDetail(grid, "نوع الاتصال", visit.connectionType);
    addDetail(grid, "منطقة IP الزمنية", visit.ipTimezone);
    addDetail(grid, "المتصفح", visit.browser);
    addDetail(grid, "نظام التشغيل", visit.os);
    addDetail(grid, "الجهاز", visit.device);
    addDetail(grid, "لغة المتصفح", visit.language);
    addDetail(grid, "منطقة الجهاز الزمنية", visit.timezone);
    addDetail(grid, "مصدر الإحالة", visit.referrer);
    addDetail(grid, "دقة الموقع", visit.accuracy);

    const actions = document.createElement("div");
    actions.className = "visit-actions";
    if (visit.mapQuery) {
      const map = document.createElement("a");
      map.className = "map-button";
      map.href = mapSearchUrl(visit.mapQuery);
      map.target = "_blank";
      map.rel = "noopener noreferrer";
      map.textContent = "عرض المدينة على الخريطة";
      actions.appendChild(map);
    }
    row.append(heading, grid, actions);
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

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    total: latestAnalytics.total || 0,
    visits: latestAnalytics.visits || []
  };
  downloadFile("nard-visit-report.json", JSON.stringify(payload, null, 2), "application/json");
}

function exportCsv() {
  const columns = [
    ["visitedAt", "وقت الزيارة"], ["ipMasked", "IP محجوب"], ["flag", "العلم"],
    ["country", "الدولة"], ["region", "المحافظة أو المنطقة"], ["city", "المدينة"],
    ["isp", "مزود الإنترنت"], ["organization", "المؤسسة"], ["asn", "ASN"],
    ["connectionType", "نوع الاتصال"], ["ipTimezone", "منطقة IP الزمنية"],
    ["browser", "المتصفح"], ["os", "نظام التشغيل"], ["device", "الجهاز"],
    ["language", "اللغة"], ["timezone", "المنطقة الزمنية للجهاز"],
    ["screen", "فئة الشاشة"], ["referrer", "مصدر الإحالة"], ["accuracy", "دقة الموقع"]
  ];
  const quote = (value) => '"' + String(value == null ? "" : value).replace(/"/g, '""') + '"';
  const rows = [columns.map((column) => quote(column[1])).join(",")];
  (latestAnalytics.visits || []).forEach((visit) => {
    rows.push(columns.map(([key]) => quote(key === "visitedAt" ? new Date(visit[key]).toISOString() : visit[key])).join(","));
  });
  downloadFile("nard-visit-report.csv", "\uFEFF" + rows.join("\r\n"), "text/csv");
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
    sessionStorage.setItem("nard_share_url", data.shareUrl);
    sessionStorage.setItem("nard_expiry_text", "الرابط صالح لمدة " + data.ttlMinutes + " دقيقة.");
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
  sessionStorage.removeItem("nard_share_url");
  sessionStorage.removeItem("nard_expiry_text");
  ownerToken = null;
  latestAnalytics = { total: 0, visits: [] };
  $("ownerResult").classList.add("hidden");
  $("createSession").classList.remove("hidden");
  setText("analyticsUpdated", "تم إيقاف الرابط وحذف بيانات جلسته من الذاكرة.");
}

function initAdmin() {
  $("createSession").addEventListener("click", createSession);
  $("refreshAnalytics").addEventListener("click", loadAnalytics);
  $("exportJson").addEventListener("click", exportJson);
  $("exportCsv").addEventListener("click", exportCsv);
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
    $("shareLink").value = sessionStorage.getItem("nard_share_url") || "";
    setText("expiryText", sessionStorage.getItem("nard_expiry_text") || "الجلسة محفوظة في علامة التبويب الحالية.");
    $("ownerResult").classList.remove("hidden");
    $("createSession").classList.add("hidden");
    startAnalyticsRefresh();
  }
}

function initVisitor() {
  $("ownerPanel").classList.add("hidden");
  $("visitorPanel").classList.remove("hidden");
  $("consentAccept").addEventListener("click", recordConsentVisit);
  $("consentDecline").addEventListener("click", recordAnonymousVisit);
}

if (isVisitor) initVisitor();
else initAdmin();
