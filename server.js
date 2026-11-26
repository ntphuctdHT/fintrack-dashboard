/**
 * Máy chủ trung gian AccessTrade cho Dasboard Fin (Node 18+, không dùng thư viện ngoài)
 *
 * Hướng dẫn chạy nhanh:
 * 1. Khởi chạy máy chủ:
 *      node server.js
 *    (Tuỳ chọn: đặt sẵn ACCESSTRADE_KEY="khoa_cua_ban" hoặc dán trực tiếp trong mục Cài đặt trên web)
 *    (Tuỳ chọn khi chạy thật: thêm ALLOWED_ORIGIN="https://ten-mien-cua-ban.com")
 * 2. Mở trình duyệt tại http://localhost:3000
 * 3. Vào Cài đặt -> dán Access Key -> chọn "Dữ liệu thật từ AccessTrade" -> bấm "Lưu và tải lại".
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

function loadLocalEnvFile() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (fs.existsSync(envPath)) {
      const raw = fs.readFileSync(envPath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const k = trimmed.slice(0, eqIdx).trim();
          let v = trimmed.slice(eqIdx + 1).trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (process.env[k] === undefined) {
            process.env[k] = v;
          }
        }
      }
    }
  } catch (_e) {}
}
loadLocalEnvFile();

const SUPABASE_URL = (
  process.env.SUPABASE_URL || "https://qdsmiptuqkrnyfynnoxu.supabase.co"
).trim().replace(/\/+$/, "");
const SUPABASE_KEY = (
  process.env.SUPABASE_KEY || "sb_publishable_NExQDC6cWPJXoxwHEm4Jug_zbYZA5rD"
).trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const ENV_ACCESSTRADE_KEY = (process.env.ACCESSTRADE_KEY || "").trim();
const SYNC_SECRET = (process.env.SYNC_SECRET || "").trim();
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();
const SYNC_PACE_MS = process.env.SYNC_PACE_MS !== undefined ? Math.max(0, Number(process.env.SYNC_PACE_MS) || 0) : 7000;
const SYNC_RETRY_DELAYS_MS = process.env.SYNC_TEST_FAST === "1" ? [20, 40, 80] : [2000, 4000, 8000];
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "*").trim() || "*";
const PORT = Number(process.env.PORT) || 3000;
const AT_BASE = (process.env.AT_BASE || "https://api.accesstrade.vn").trim().replace(/\/+$/, "");

const CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const UPSTREAM_TIMEOUT_MS = 15000;
const SHORTENER_TEST_BASE = (process.env.SHORTENER_TEST_BASE || "").trim().replace(/\/+$/, "");
const ISGD_API_BASE = (process.env.ISGD_API_BASE || "https://is.gd").trim().replace(/\/+$/, "");
const TINYURL_API_BASE = (process.env.TINYURL_API_BASE || "https://tinyurl.com").trim().replace(/\/+$/, "");
const MAX_SHORTENER_HOPS = 5;
const ALLOWED_SHORTENER_HOSTS = new Set([
  "shorten.asia",
  "www.shorten.asia",
  "rutgon.me",
  "s.isclix.com",
  "shorten.accesstrade.vn",
  "shorten.dev.accesstrade.me",
  "is.gd",
  "www.is.gd",
  "tinyurl.com",
  "www.tinyurl.com"
]);

function isAccessTradeTrackingHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  return (
    host === "go.isclix.com" ||
    host.endsWith(".isclix.com") ||
    host === "click.accesstrade.vn" ||
    host === "tracking.accesstrade.vn" ||
    host.endsWith(".accesstrade.me")
  );
}

try {
  const parsedBase = new URL(AT_BASE);
  if (parsedBase.protocol !== "https:" && parsedBase.protocol !== "http:") {
    throw new Error("Protocol không hợp lệ");
  }
} catch (_err) {
  console.error("[LỖI KHỞI ĐỘNG] Biến AT_BASE không phải URL hợp lệ.");
  process.exit(1);
}

const INDEX_HTML_PATH = path.join(__dirname, "index.html");
const CTV_VIEW_HTML_PATH = path.join(__dirname, "ctv-view.html");
const BRIDGE_STATE_PATH = process.env.VERCEL
  ? path.join("/tmp", ".ctv-bridge-state.json")
  : path.join(__dirname, ".ctv-bridge-state.json");
const cache = new Map();
const inFlight = new Map();
const viewRateMap = new Map();

const DEFAULT_AT_RATES = { low: 2.45, medium: 1.93, high: 1.58 };
const DEFAULT_CTV_RATES = { low: 1.8, medium: 1.28, high: 1.0 };
const DEFAULT_PROJECT_NOTE =
  "Đối soát và thanh toán vào ngày 18 và 25 hằng tháng, mốc có thể khác theo chiến dịch";

let bridgeRuntimeKey = "";
let bridgeState = {
  mode: "real",
  ctvList: [],
  ctvLinkConfig: {
    publisher: "",
    campaign: "",
    targetUrl: "",
    baseSalesLink: "",
    viewBase: "",
    salesLinkMode: "short_auto",
    trackClicks: true,
    defaultProject: "vietcredit",
    projects: {}
  },
  ctvShortLinks: {},
  clickStats: {},
  policy: {
    ownerName: "Dasboard Fin",
    ctvField: "sub2",
    defaultRisk: "high",
    atRates: { ...DEFAULT_AT_RATES },
    ctvRates: { ...DEFAULT_CTV_RATES },
    leadRisks: {}
  },
  syncedLeads: []
};

function sanitizeProjectsMap(raw) {
  const clean = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return clean;
  for (const k of Object.keys(raw)) {
    const key = String(k || "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,30}$/.test(key)) continue;
    const item = raw[k];
    if (!item || typeof item !== "object") continue;
    clean[key] = {
      id: key,
      name: String(item.name || "").slice(0, 80),
      tag: String(item.tag || "").slice(0, 40),
      desc: String(item.desc || "").slice(0, 200),
      baseSalesLink: typeof item.baseSalesLink === "string" ? item.baseSalesLink.trim() : "",
      sampleLink: typeof item.sampleLink === "string" ? item.sampleLink.trim() : "",
      publisher: typeof item.publisher === "string" ? item.publisher.trim() : "",
      campaign: typeof item.campaign === "string" ? item.campaign.trim() : "",
      targetUrl: typeof item.targetUrl === "string" ? item.targetUrl.trim() : "",
      enabled: item.enabled !== false
    };
  }
  return clean;
}

function hasProjectConfigData(proj) {
  if (!proj || typeof proj !== "object") return false;
  return Boolean(
    (typeof proj.baseSalesLink === "string" && proj.baseSalesLink.trim()) ||
    (typeof proj.publisher === "string" && proj.publisher.trim()) ||
    (typeof proj.campaign === "string" && proj.campaign.trim()) ||
    (typeof proj.targetUrl === "string" && proj.targetUrl.trim()) ||
    (typeof proj.sampleLink === "string" && proj.sampleLink.trim())
  );
}

function mergeCtvLinkConfigs(baseCfg, incomingCfg, preserveExistingProjects = true) {
  const base = baseCfg && typeof baseCfg === "object" ? baseCfg : {};
  const inc = incomingCfg && typeof incomingCfg === "object" ? incomingCfg : {};
  const baseProjects = sanitizeProjectsMap(base.projects);
  const incProjects = sanitizeProjectsMap(inc.projects);
  const mergedProjects = { ...baseProjects };
  for (const key of Object.keys(incProjects)) {
    const incProj = incProjects[key];
    const baseProj = mergedProjects[key];
    if (preserveExistingProjects && baseProj && hasProjectConfigData(baseProj) && !hasProjectConfigData(incProj)) {
      continue;
    }
    mergedProjects[key] = incProj;
  }
  return {
    publisher: typeof inc.publisher === "string" ? inc.publisher.trim() : (typeof base.publisher === "string" ? base.publisher.trim() : ""),
    campaign: typeof inc.campaign === "string" ? inc.campaign.trim() : (typeof base.campaign === "string" ? base.campaign.trim() : ""),
    targetUrl: typeof inc.targetUrl === "string" ? inc.targetUrl.trim() : (typeof base.targetUrl === "string" ? base.targetUrl.trim() : ""),
    baseSalesLink: typeof inc.baseSalesLink === "string" ? inc.baseSalesLink.trim() : (typeof base.baseSalesLink === "string" ? base.baseSalesLink.trim() : ""),
    viewBase: typeof inc.viewBase === "string" ? inc.viewBase.trim().replace(/\/+$/, "") : (typeof base.viewBase === "string" ? base.viewBase.trim().replace(/\/+$/, "") : ""),
    salesLinkMode: typeof inc.salesLinkMode === "string" && inc.salesLinkMode.trim() ? inc.salesLinkMode.trim() : (base.salesLinkMode || "short_auto"),
    trackClicks: typeof inc.trackClicks === "boolean" ? inc.trackClicks : base.trackClicks !== false,
    defaultProject: typeof inc.defaultProject === "string" && inc.defaultProject.trim() ? inc.defaultProject.trim() : (base.defaultProject || "vietcredit"),
    projects: mergedProjects
  };
}

function sanitizeClickStatsMap(rawMap) {
  const clean = {};
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) return clean;
  for (const ref of Object.keys(rawMap)) {
    if (!/^[a-z0-9]{4,20}$/i.test(ref)) continue;
    const entry = rawMap[ref];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const total = Math.max(0, Math.round(Number(entry.total) || 0));
    const byDay = {};
    if (entry.byDay && typeof entry.byDay === "object" && !Array.isArray(entry.byDay)) {
      const dayKeys = Object.keys(entry.byDay)
        .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
        .sort()
        .slice(-45);
      for (const dk of dayKeys) {
        const cnt = Math.max(0, Math.round(Number(entry.byDay[dk]) || 0));
        if (cnt > 0) byDay[dk] = cnt;
      }
    }
    const lastClickAt = typeof entry.lastClickAt === "string" ? entry.lastClickAt : "";
    clean[ref] = { total, byDay, lastClickAt };
  }
  return clean;
}

function loadBridgeStateFromDisk() {
  try {
    if (!fs.existsSync(BRIDGE_STATE_PATH)) return;
    const raw = fs.readFileSync(BRIDGE_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parsedCfg =
        parsed.ctvLinkConfig && typeof parsed.ctvLinkConfig === "object"
          ? parsed.ctvLinkConfig
          : {};
      bridgeState = {
        ...bridgeState,
        ...parsed,
        ctvList: Array.isArray(parsed.ctvList) ? parsed.ctvList : [],
        ctvLinkConfig: {
          publisher: typeof parsedCfg.publisher === "string" ? parsedCfg.publisher.trim() : "",
          campaign: typeof parsedCfg.campaign === "string" ? parsedCfg.campaign.trim() : "",
          targetUrl: typeof parsedCfg.targetUrl === "string" ? parsedCfg.targetUrl.trim() : "",
          baseSalesLink:
            typeof parsedCfg.baseSalesLink === "string" ? parsedCfg.baseSalesLink.trim() : "",
          viewBase: typeof parsedCfg.viewBase === "string" ? parsedCfg.viewBase.trim() : "",
          salesLinkMode:
            typeof parsedCfg.salesLinkMode === "string" && parsedCfg.salesLinkMode.trim()
              ? parsedCfg.salesLinkMode.trim()
              : "short_auto",
          trackClicks: parsedCfg.trackClicks !== false,
          defaultProject:
            typeof parsedCfg.defaultProject === "string" && parsedCfg.defaultProject.trim()
              ? parsedCfg.defaultProject.trim()
              : "vietcredit",
          projects: sanitizeProjectsMap(parsedCfg.projects)
        },
        ctvShortLinks:
          parsed.ctvShortLinks && typeof parsed.ctvShortLinks === "object"
            ? parsed.ctvShortLinks
            : {},
        clickStats: sanitizeClickStatsMap(parsed.clickStats),
        syncedLeads: Array.isArray(parsed.syncedLeads) ? parsed.syncedLeads : [],
        accessKey: typeof parsed.accessKey === "string" ? parsed.accessKey.trim() : ""
      };
      if (parsed.accessKey && !bridgeRuntimeKey) { bridgeRuntimeKey = parsed.accessKey.trim(); }
    }
  } catch (_err) {
    // Bỏ qua nếu file trạng thái cầu nối chưa tồn tại hoặc hỏng
  }
}

function saveBridgeStateToDisk() {
  try {
    const safeCopy = {
      mode: bridgeState.mode,
      ctvList: bridgeState.ctvList,
      ctvLinkConfig: bridgeState.ctvLinkConfig,
      ctvShortLinks: bridgeState.ctvShortLinks,
      clickStats: sanitizeClickStatsMap(bridgeState.clickStats),
      policy: bridgeState.policy,
      accessKey: bridgeRuntimeKey || bridgeState.accessKey || "",
      syncedLeads: bridgeState.syncedLeads
    };
    fs.writeFileSync(BRIDGE_STATE_PATH, JSON.stringify(safeCopy), "utf8");
  } catch (_err) {
    // Bỏ qua nếu hệ thống file chỉ đọc
  }
}

loadBridgeStateFromDisk();

async function supabaseFetch(subPath, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  const targetUrl = `${SUPABASE_URL}/rest/v1/${subPath.replace(/^\/+/, "")}`;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 4000) : null;
  try {
    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    };
    const res = await fetch(targetUrl, {
      ...options,
      headers,
      signal: controller ? controller.signal : undefined
    });
    if (timer) clearTimeout(timer);
    return res;
  } catch (_e) {
    if (timer) clearTimeout(timer);
    return null;
  }
}

async function getCtvsFromSupabase() {
  try {
    const res = await supabaseFetch("ctvs?select=*");
    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    return rows.map((r) => ({
      id: String(r.id || r.ref),
      name: String(r.name || "").slice(0, 40),
      ref: String(r.ref || "").toLowerCase(),
      view: String(r.view_code || ""),
      active: r.active !== false
    }));
  } catch (_e) {
    return null;
  }
}

async function getCtvByViewCodeFromSupabase(viewCode) {
  try {
    const res = await supabaseFetch(`ctvs?view_code=eq.${encodeURIComponent(viewCode)}&select=*`);
    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const r = rows[0];
    return {
      id: String(r.id || r.ref),
      name: String(r.name || "").slice(0, 40),
      ref: String(r.ref || "").toLowerCase(),
      view: String(r.view_code || ""),
      active: r.active !== false
    };
  } catch (_e) {
    return null;
  }
}

async function getCtvByRefFromSupabase(ref) {
  try {
    const res = await supabaseFetch(`ctvs?ref=eq.${encodeURIComponent(ref)}&select=*`);
    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const r = rows[0];
    return {
      id: String(r.id || r.ref),
      name: String(r.name || "").slice(0, 40),
      ref: String(r.ref || "").toLowerCase(),
      view: String(r.view_code || ""),
      active: r.active !== false
    };
  } catch (_e) {
    return null;
  }
}

async function saveCtvsToSupabase(ctvList, replaceAll = false) {
  if (!Array.isArray(ctvList)) return false;
  try {
    if (replaceAll) {
      const existing = await getCtvsFromSupabase();
      if (Array.isArray(existing) && existing.length > 0) {
        const keepRefs = new Set(ctvList.map((c) => String(c && c.ref || "").toLowerCase()).filter(Boolean));
        const toDelete = existing.filter((ex) => ex && ex.ref && !keepRefs.has(String(ex.ref).toLowerCase()));
        await Promise.all(
          toDelete.map((ex) =>
            Promise.all([
              supabaseFetch(`ctvs?ref=eq.${encodeURIComponent(ex.ref)}`, { method: "DELETE" }),
              supabaseFetch(`ctv_clicks?ref=eq.${encodeURIComponent(ex.ref)}`, { method: "DELETE" })
            ])
          )
        );
      }
    }
    if (ctvList.length === 0) return true;
    const rows = ctvList.map((c) => ({
      id: String(c.id || c.ref),
      name: String(c.name || "").slice(0, 40),
      ref: String(c.ref || "").toLowerCase(),
      view_code: String(c.view || ""),
      active: c.active !== false,
      updated_at: new Date().toISOString()
    }));
    const res = await supabaseFetch("ctvs", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(rows)
    });
    return res && res.ok;
  } catch (_e) {
    return false;
  }
}

async function getSettingsFromSupabase() {
  try {
    const res = await supabaseFetch("app_settings?key=eq.ctv_config&select=*");
    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0].value;
  } catch (_e) {
    return null;
  }
}

async function saveSettingsToSupabase(val, key = "ctv_config") {
  try {
    const res = await supabaseFetch("app_settings", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        key,
        value: val,
        updated_at: new Date().toISOString()
      })
    });
    return res && res.ok;
  } catch (_e) {
    return false;
  }
}

async function getLeadsSnapshotFromSupabase() {
  try {
    const res = await supabaseFetch("app_settings?key=eq.at_leads_cache&select=*");
    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0].value;
  } catch (_e) {
    return null;
  }
}

async function saveLeadsSnapshotToSupabase(leadsList) {
  if (!Array.isArray(leadsList) || leadsList.length === 0) return false;
  try {
    const clean = leadsList.slice(0, 2000).map((l) => {
      const subs = l && l.subs && typeof l.subs === "object" ? l.subs : {};
      return {
        conversionId: String(l.conversionId || ""),
        campaignName: String(l.campaignName || "Sản phẩm tài chính"),
        timeRaw: String(l.timeRaw || ""),
        commission: Number.isFinite(Number(l.commission)) ? Math.round(Number(l.commission)) : 0,
        statusKey: String(l.statusKey || "pending"),
        subs: {
          sub1: typeof subs.sub1 === "string" ? subs.sub1.trim() : "",
          sub2: typeof subs.sub2 === "string" ? subs.sub2.trim() : "",
          sub3: typeof subs.sub3 === "string" ? subs.sub3.trim() : "",
          sub4: typeof subs.sub4 === "string" ? subs.sub4.trim() : ""
        },
        apiRiskLevel: normalizeRiskTier(l.apiRiskLevel)
      };
    });
    const now = new Date();
    // Snapshot TTL: 10 phút (giảm tải 100% việc gọi AccessTrade liên tục)
    const expires = new Date(now.getTime() + 10 * 60000);
    return await saveSettingsToSupabase({
      cached_at: now.toISOString(),
      expires_at: expires.toISOString(),
      total_leads: clean.length,
      leads: clean
    }, "at_leads_cache");
  } catch (_e) {
    return false;
  }
}

async function getClicksFromSupabase() {
  try {
    const res = await supabaseFetch("ctv_clicks?select=*");
    if (!res || !res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    const map = {};
    for (const r of rows) {
      if (!r || !r.ref) continue;
      map[r.ref] = {
        total: Number(r.total) || 0,
        byDay: r.by_day && typeof r.by_day === "object" ? r.by_day : {},
        lastClickAt: r.last_click_at || ""
      };
    }
    return map;
  } catch (_e) {
    return null;
  }
}

async function recordClickInSupabase(ref) {
  try {
    const today = formatServerYmdGmt7(new Date());
    const nowIso = new Date().toISOString();
    const res = await supabaseFetch(`ctv_clicks?ref=eq.${encodeURIComponent(ref)}&select=*`);
    let currentTotal = 0;
    let currentByDay = {};
    if (res && res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        currentTotal = Number(rows[0].total) || 0;
        currentByDay = rows[0].by_day && typeof rows[0].by_day === "object" ? rows[0].by_day : {};
      }
    }
    const newTotal = currentTotal + 1;
    currentByDay[today] = (Number(currentByDay[today]) || 0) + 1;
    await supabaseFetch("ctv_clicks", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        ref,
        total: newTotal,
        by_day: currentByDay,
        last_click_at: nowIso,
        updated_at: nowIso
      })
    });
  } catch (_e) {
    // ignore
  }
}

function isValidDateYmd(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-AccessTrade-Key, X-Sync-Secret, X-Cron-Secret, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "X-CTV-Bridge");
  if (ALLOWED_ORIGIN !== "*") {
    res.setHeader("Vary", "Origin");
  }
}

const SYNC_STATE_KEY = "conversions_sync";
const SYNC_LOCK_TTL_MS = 90 * 1000;
const SYNC_AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
const SYNC_AUTH_MAX_FAILURES = 5;
const syncAuthFailByIp = new Map();

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function timingSafeSecretMatch(provided, expected) {
  const a = typeof provided === "string" ? provided : "";
  const b = typeof expected === "string" ? expected : "";
  if (!a || !b) return false;
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

function verifySyncSecretAuth(req, expectedSecret, candidateHeaders) {
  const ip = getClientIp(req);
  const now = Date.now();
  const rec = syncAuthFailByIp.get(ip);
  if (rec && rec.lockedUntil && now < rec.lockedUntil) {
    return { ok: false, status: 429, error: "Quá nhiều lần nhập sai mã bí mật. Vui lòng thử lại sau 15 phút." };
  }
  if (!expectedSecret) {
    return { ok: false, status: 503, error: "Chưa cấu hình biến môi trường mã bí mật trên máy chủ." };
  }
  let provided = "";
  for (const hName of candidateHeaders) {
    const raw = req.headers[hName];
    if (typeof raw === "string" && raw.trim()) {
      const val = raw.trim();
      if (hName === "authorization" && /^bearer\s+/i.test(val)) {
        provided = val.replace(/^bearer\s+/i, "").trim();
      } else if (hName !== "authorization") {
        provided = val;
      }
      if (provided) break;
    }
  }
  if (timingSafeSecretMatch(provided, expectedSecret)) {
    syncAuthFailByIp.delete(ip);
    return { ok: true };
  }
  const prevCount = rec && now - rec.firstFailAt <= SYNC_AUTH_FAIL_WINDOW_MS ? rec.count : 0;
  const nextCount = prevCount + 1;
  const lockedUntil = nextCount >= SYNC_AUTH_MAX_FAILURES ? now + SYNC_AUTH_FAIL_WINDOW_MS : 0;
  syncAuthFailByIp.set(ip, {
    count: nextCount,
    firstFailAt: prevCount > 0 && rec ? rec.firstFailAt : now,
    lockedUntil
  });
  if (lockedUntil) {
    return { ok: false, status: 429, error: "Nhập sai mã bí mật quá số lần cho phép. Vui lòng thử lại sau 15 phút." };
  }
  return { ok: false, status: 401, error: "Mã bí mật đồng bộ không hợp lệ." };
}

async function supabaseServiceFetch(subPath, options = {}) {
  const keyToUse = SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !keyToUse) return null;
  const targetUrl = `${SUPABASE_URL}/rest/v1/${subPath.replace(/^\/+/, "")}`;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 12000) : null;
  try {
    const headers = {
      apikey: keyToUse,
      Authorization: `Bearer ${keyToUse}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    };
    const res = await fetch(targetUrl, {
      ...options,
      headers,
      signal: controller ? controller.signal : undefined
    });
    if (timer) clearTimeout(timer);
    return res;
  } catch (_e) {
    if (timer) clearTimeout(timer);
    return null;
  }
}

async function getSyncStateRow(key = SYNC_STATE_KEY) {
  const res = await supabaseServiceFetch(`sync_state?key=eq.${encodeURIComponent(key)}&select=*`);
  if (!res || !res.ok) return null;
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const val = rows[0].value;
  return val && typeof val === "object" && !Array.isArray(val) ? val : {};
}

async function saveSyncStateRow(val, key = SYNC_STATE_KEY) {
  const res = await supabaseServiceFetch("sync_state?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      key,
      value: val && typeof val === "object" ? val : {},
      updated_at: new Date().toISOString()
    })
  });
  return Boolean(res && res.ok);
}

function ensureGmt7Iso(rawVal) {
  if (rawVal == null) return null;
  const s = String(rawVal).trim();
  if (!s) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const dt = new Date(s);
    return Number.isNaN(dt.getTime()) ? null : s;
  }
  const normalized = s.includes("T") ? s : s.replace(" ", "T");
  const withOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(normalized)
    ? normalized + (normalized.length === 16 ? ":00+07:00" : "+07:00")
    : normalized + "+07:00";
  const dt = new Date(withOffset);
  return Number.isNaN(dt.getTime()) ? null : withOffset;
}

function pickAtTrackingField(item, keyName) {
  if (!item || typeof item !== "object") return "";
  const extra = item._extra && typeof item._extra === "object" ? item._extra : {};
  const extraParams = extra.parameters && typeof extra.parameters === "object" ? extra.parameters : {};
  const params = item.parameters && typeof item.parameters === "object" ? item.parameters : {};
  const candidates = [item[keyName], extra[keyName], extraParams[keyName], params[keyName]];
  for (const c of candidates) {
    if (c != null && String(c).trim() !== "") return String(c).trim();
  }
  return "";
}

function mapAccessTradeItemToConversionRow(item) {
  if (!item || typeof item !== "object") return null;
  const rawConvId = item.conversion_id != null && item.conversion_id !== "" ? item.conversion_id : item.id;
  const convIdNum = Number(rawConvId);
  if (!Number.isFinite(convIdNum) || convIdNum <= 0 || !Number.isInteger(convIdNum)) {
    return null;
  }
  const sub2 = pickAtTrackingField(item, "sub2");
  const utmCampaign = pickAtTrackingField(item, "utm_campaign");
  const sub2Norm = sub2.trim().toLowerCase();
  const utmNorm = utmCampaign.trim().toLowerCase();
  const ctvRef = sub2Norm || utmNorm || null;
  let ctvSource = "none";
  if (sub2Norm && utmNorm) {
    ctvSource = sub2Norm === utmNorm ? "both" : "sub2";
  } else if (sub2Norm) {
    ctvSource = "sub2";
  } else if (utmNorm) {
    ctvSource = "utm_campaign";
  }
  const ctvConflict = Boolean(sub2Norm && utmNorm && sub2Norm !== utmNorm);

  const rawStatus = Number(item.status);
  const statusInt = Number.isFinite(rawStatus) ? Math.trunc(rawStatus) : 0;
  const isConfInt = item.is_confirmed === true ? 1 : (Number.isFinite(Number(item.is_confirmed)) ? Math.trunc(Number(item.is_confirmed)) : 0);
  const rawOrderVal = item.transaction_value != null && item.transaction_value !== "" ? Number(item.transaction_value) : Number(item.billing);
  const orderValue = Number.isFinite(rawOrderVal) ? rawOrderVal : 0;
  const rawComm = Number(item.commission);
  const commission = Number.isFinite(rawComm) ? rawComm : 0;

  const salesTime = ensureGmt7Iso(item.transaction_time || item.sales_time || item.click_time);
  const updateTime = ensureGmt7Iso(item.update_time || item.transaction_time || item.sales_time);
  const orderId = String(item.transaction_id != null && item.transaction_id !== "" ? item.transaction_id : (item.order_id || convIdNum)).trim();
  const advertiser = String(
    item.merchant ||
    item.campaign_name ||
    (item.campaign_id != null && item.campaign_id !== "" ? "Chiến dịch #" + item.campaign_id : "Sản phẩm tài chính")
  ).trim();

  return {
    conversion_id: convIdNum,
    sales_time: salesTime,
    order_id: orderId,
    order_value: orderValue,
    advertiser,
    commission,
    status: statusInt,
    is_confirmed: isConfInt,
    update_time: updateTime,
    utm_campaign: utmCampaign || null,
    sub2: sub2 || null,
    ctv_ref: ctvRef,
    ctv_source: ctvSource,
    ctv_conflict: ctvConflict,
    tracking: {
      sub1: pickAtTrackingField(item, "sub1"),
      sub2,
      sub3: pickAtTrackingField(item, "sub3"),
      sub4: pickAtTrackingField(item, "sub4"),
      utm_source: pickAtTrackingField(item, "utm_source"),
      utm_medium: pickAtTrackingField(item, "utm_medium"),
      utm_campaign: utmCampaign,
      utm_content: pickAtTrackingField(item, "utm_content"),
      extra: item._extra && typeof item._extra === "object" ? item._extra : null
    },
    synced_at: new Date().toISOString()
  };
}

async function upsertConversionsBatch(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true, count: 0 };
  let totalUpserted = 0;
  const batchSize = 200;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const res = await supabaseServiceFetch("conversions?on_conflict=conversion_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(chunk)
    });
    if (!res || !res.ok) {
      let detail = res ? "HTTP " + res.status : "Không kết nối được Supabase";
      try {
        if (res) {
          const txt = await res.text();
          if (txt) detail += ": " + txt.slice(0, 160);
        }
      } catch (_e) {}
      throw new Error("Ghi dữ liệu vào Supabase conversions thất bại (" + detail + ").");
    }
    totalUpserted += chunk.length;
  }
  return { ok: true, count: totalUpserted };
}

async function enforceSharedSyncRateBudget(syncState) {
  if (!syncState.rate_budget || typeof syncState.rate_budget !== "object") {
    syncState.rate_budget = { last_request_at: "", recent_requests: [] };
  }
  const now = Date.now();
  const lastMs = syncState.rate_budget.last_request_at ? new Date(syncState.rate_budget.last_request_at).getTime() : 0;
  if (lastMs > 0 && now - lastMs < SYNC_PACE_MS) {
    await sleepMs(SYNC_PACE_MS - (now - lastMs));
  }

  let checkNow = Date.now();
  let recent = Array.isArray(syncState.rate_budget.recent_requests)
    ? syncState.rate_budget.recent_requests
        .map((t) => new Date(t).getTime())
        .filter((ms) => Number.isFinite(ms) && checkNow - ms < 60000)
        .sort((a, b) => a - b)
    : [];

  if (recent.length >= 10) {
    const waitForWindow = Math.max(0, 60000 - (checkNow - recent[0]) + 250);
    if (waitForWindow > 30000) {
      const err = new Error("Đã đạt ngưỡng 10 request/phút dùng chung của AccessTrade. Vui lòng thử lại sau " + Math.ceil(waitForWindow / 1000) + " giây.");
      err.statusCode = 429;
      err.retryAfterSec = Math.ceil(waitForWindow / 1000);
      throw err;
    }
    await sleepMs(waitForWindow);
    checkNow = Date.now();
    recent = recent.filter((ms) => checkNow - ms < 60000);
  }

  const stampIso = new Date().toISOString();
  recent.push(Date.now());
  syncState.rate_budget = {
    last_request_at: stampIso,
    recent_requests: recent.slice(-15).map((ms) => new Date(ms).toISOString())
  };
  await saveSyncStateRow(syncState);
}

async function fetchTransactionsSyncPageWithRetry(queryParams, accessKey, syncState) {
  const maxAttempts = 4; // 1 initial + max 3 retries
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await enforceSharedSyncRateBudget(syncState);
    const upstreamUrl = new URL(AT_BASE + "/v1/transactions");
    for (const [k, v] of Object.entries(queryParams)) {
      if (v != null && String(v) !== "") {
        upstreamUrl.searchParams.set(k, String(v));
      }
    }

    let response = null;
    let netErr = null;
    try {
      response = await fetch(upstreamUrl.toString(), {
        method: "GET",
        headers: {
          Authorization: "Token " + accessKey,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
    } catch (err) {
      netErr = err;
    }

    if (response && response.status === 429) {
      let retrySec = 10;
      try {
        const hdr = response.headers.get("retry-after");
        if (hdr && Number.isFinite(Number(hdr))) retrySec = Math.max(1, Number(hdr));
        const body429 = await response.json().catch(() => null);
        if (body429 && Number.isFinite(Number(body429.retry_after))) {
          retrySec = Math.max(1, Number(body429.retry_after));
        }
      } catch (_e) {}
      if (attempt < maxAttempts - 1) {
        const cappedWait = process.env.SYNC_TEST_FAST === "1"
          ? Math.min(200, retrySec * 10)
          : Math.min(30000, retrySec * 1000);
        await sleepMs(cappedWait);
        continue;
      }
      const err429 = new Error("AccessTrade giới hạn tốc độ (429). Vui lòng thử lại sau " + retrySec + " giây.");
      err429.statusCode = 429;
      throw err429;
    }

    const isRetryableHttp = response && (response.status === 502 || response.status === 503 || response.status === 504);
    if (netErr || isRetryableHttp) {
      if (attempt < maxAttempts - 1) {
        await sleepMs(SYNC_RETRY_DELAYS_MS[attempt] || 8000);
        continue;
      }
      const err5xx = new Error(
        netErr
          ? "Lỗi kết nối AccessTrade khi đồng bộ."
          : "AccessTrade tạm gián đoạn (HTTP " + response.status + ") sau 3 lần thử lại."
      );
      err5xx.statusCode = 502;
      throw err5xx;
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const authErr = new Error("Access Key trên máy chủ không hợp lệ hoặc hết quyền (HTTP " + response.status + ").");
        authErr.statusCode = 502;
        throw authErr;
      }
      const errHttp = new Error("AccessTrade trả về HTTP " + response.status + ".");
      errHttp.statusCode = 502;
      throw errHttp;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (_jsonErr) {
      if (attempt < maxAttempts - 1) {
        await sleepMs(SYNC_RETRY_DELAYS_MS[attempt] || 8000);
        continue;
      }
      const parseErr = new Error("AccessTrade trả về JSON không hợp lệ.");
      parseErr.statusCode = 502;
      throw parseErr;
    }

    // Luôn kiểm tra success: false trước khi đọc data
    if (payload && payload.success === false) {
      if (attempt < maxAttempts - 1) {
        await sleepMs(SYNC_RETRY_DELAYS_MS[attempt] || 8000);
        continue;
      }
      const apiMsg = typeof payload.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "AccessTrade trả về success: false.";
      const failErr = new Error(apiMsg);
      failErr.statusCode = 502;
      throw failErr;
    }

    return Array.isArray(payload && payload.data) ? payload.data : [];
  }
  return [];
}

function buildBackfillWeeks60d(nowDate = new Date()) {
  const endMs = nowDate.getTime();
  const start60Ms = endMs - 60 * 86400000;
  const weeks = [];
  let cursorEnd = endMs;
  while (cursorEnd > start60Ms) {
    const cursorStart = Math.max(start60Ms, cursorEnd - 7 * 86400000);
    weeks.push({
      since: new Date(cursorStart).toISOString().replace(/\.\d{3}Z$/, "Z"),
      until: new Date(cursorEnd).toISOString().replace(/\.\d{3}Z$/, "Z")
    });
    cursorEnd = cursorStart;
  }
  return weeks;
}

async function runConversionsSync({ mode = "incremental", source = "manual", weekIndex = 0, limit = 200 } = {}) {
  if (!ENV_ACCESSTRADE_KEY) {
    const err = new Error("Chưa cấu hình biến môi trường ACCESSTRADE_KEY trên máy chủ.");
    err.statusCode = 500;
    throw err;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const err = new Error("Chưa cấu hình SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trên máy chủ.");
    err.statusCode = 500;
    throw err;
  }

  const normalizedMode = mode === "backfill" ? "backfill" : "incremental";
  const pageLimit = Math.min(300, Math.max(100, Math.round(Number(limit) || 200)));
  const syncState = (await getSyncStateRow()) || {};
  const nowMs = Date.now();

  if (
    syncState.lock &&
    syncState.lock.locked === true &&
    syncState.lock.expires_at &&
    new Date(syncState.lock.expires_at).getTime() > nowMs
  ) {
    const err = new Error("Đang có một tiến trình đồng bộ khác đang chạy (khóa chống chạy chồng). Vui lòng đợi hoàn tất.");
    err.statusCode = 409;
    throw err;
  }

  const runId = crypto.randomBytes(6).toString("hex");
  syncState.lock = {
    locked: true,
    locked_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + SYNC_LOCK_TTL_MS).toISOString(),
    run_id: runId
  };
  await saveSyncStateRow(syncState);

  let upsertedCount = 0;
  let pagesFetched = 0;

  try {
    const allRows = [];
    if (normalizedMode === "incremental") {
      const endDt = new Date();
      const startDt = new Date(endDt.getTime() - 48 * 3600000); // 48 giờ gần nhất (<= 31 ngày)
      const startIso = startDt.toISOString().replace(/\.\d{3}Z$/, "Z");
      const endIso = endDt.toISOString().replace(/\.\d{3}Z$/, "Z");

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const pageItems = await fetchTransactionsSyncPageWithRetry(
          {
            update_time_start: startIso,
            update_time_end: endIso,
            limit: pageLimit,
            page
          },
          ENV_ACCESSTRADE_KEY,
          syncState
        );
        pagesFetched += 1;
        for (const item of pageItems) {
          const mapped = mapAccessTradeItemToConversionRow(item);
          if (mapped) allRows.push(mapped);
        }
        if (pageItems.length < pageLimit) break;
      }

      if (allRows.length > 0) {
        const resUp = await upsertConversionsBatch(allRows);
        upsertedCount = resUp.count;
      }

      const doneIso = new Date().toISOString();
      syncState.last_sync_at = doneIso;
      syncState.last_incremental_at = doneIso;
      syncState.last_mode = "incremental";
      syncState.last_source = source;
      syncState.last_status = "success";
      syncState.last_error = "";
      syncState.last_upserted = upsertedCount;
      return {
        ok: true,
        mode: "incremental",
        pagesFetched,
        upsertedCount,
        hasMore: false,
        syncState
      };
    } else {
      const weeks = buildBackfillWeeks60d(new Date());
      const targetWeekIdx = Math.max(0, Math.min(weeks.length - 1, Math.trunc(Number(weekIndex) || 0)));
      const targetWeek = weeks[targetWeekIdx];

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const pageItems = await fetchTransactionsSyncPageWithRetry(
          {
            since: targetWeek.since,
            until: targetWeek.until,
            limit: pageLimit,
            page
          },
          ENV_ACCESSTRADE_KEY,
          syncState
        );
        pagesFetched += 1;
        for (const item of pageItems) {
          const mapped = mapAccessTradeItemToConversionRow(item);
          if (mapped) allRows.push(mapped);
        }
        if (pageItems.length < pageLimit) break;
      }

      if (allRows.length > 0) {
        const resUp = await upsertConversionsBatch(allRows);
        upsertedCount = resUp.count;
      }

      const hasMore = targetWeekIdx + 1 < weeks.length;
      const doneIso = new Date().toISOString();
      syncState.last_sync_at = doneIso;
      syncState.last_backfill_at = doneIso;
      syncState.last_mode = "backfill";
      syncState.last_source = source;
      syncState.last_status = "success";
      syncState.last_error = "";
      syncState.last_upserted = upsertedCount;
      syncState.backfill_progress = {
        week_index: targetWeekIdx,
        total_weeks: weeks.length,
        completed: !hasMore,
        stopped_reason: ""
      };
      return {
        ok: true,
        mode: "backfill",
        weekIndex: targetWeekIdx,
        totalWeeks: weeks.length,
        weekRange: targetWeek,
        pagesFetched,
        upsertedCount,
        hasMore,
        nextWeekIndex: hasMore ? targetWeekIdx + 1 : null,
        syncState
      };
    }
  } catch (syncErr) {
    const errMsg = syncErr && syncErr.message ? String(syncErr.message) : "Lỗi đồng bộ không xác định.";
    syncState.last_mode = normalizedMode;
    syncState.last_source = source;
    syncState.last_status = "error";
    syncState.last_error = errMsg;
    if (normalizedMode === "backfill") {
      syncState.backfill_progress = {
        week_index: Math.trunc(Number(weekIndex) || 0),
        total_weeks: 9,
        completed: false,
        stopped_reason: errMsg
      };
    }
    throw syncErr;
  } finally {
    syncState.lock = {
      locked: false,
      locked_at: syncState.lock ? syncState.lock.locked_at : "",
      expires_at: "",
      run_id: runId
    };
    await saveSyncStateRow(syncState).catch(() => {});
  }
}

async function getConversionsFromSupabase({ ctvRef = "", limit = 1000 } = {}) {
  const fetcher = SUPABASE_SERVICE_ROLE_KEY ? supabaseServiceFetch : supabaseFetch;
  if (!SUPABASE_URL || (!SUPABASE_SERVICE_ROLE_KEY && !SUPABASE_KEY)) return null;
  const maxRows = Math.min(2000, Math.max(1, Math.round(Number(limit) || 1000)));
  let pathStr = `conversions?select=*&order=sales_time.desc&limit=${maxRows}`;
  if (ctvRef) {
    const refSafe = encodeURIComponent(String(ctvRef).trim().toLowerCase());
    pathStr = `conversions?or=(ctv_ref.eq.${refSafe},sub2.eq.${refSafe},utm_campaign.eq.${refSafe})&select=*&order=sales_time.desc&limit=${maxRows}`;
  }
  const res = await fetcher(pathStr, {
    headers: { Prefer: "count=exact" }
  });
  if (!res || !res.ok) return null;
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows)) return null;
  let totalExact = rows.length;
  const contentRange = res.headers.get("content-range") || "";
  const mRange = contentRange.match(/\/(\d+)$/);
  if (mRange && Number.isFinite(Number(mRange[1]))) {
    totalExact = Number(mRange[1]);
  }
  return { rows, totalInSupabase: totalExact };
}

function readJsonBody(req, maxBytes) {
  const limit = Number(maxBytes) || 16384;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        const err = new Error("Dữ liệu gửi lên quá lớn.");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          const objErr = new Error("Nội dung JSON phải là một đối tượng.");
          objErr.statusCode = 400;
          reject(objErr);
          return;
        }
        resolve(parsed);
      } catch (_parseErr) {
        const err = new Error("Nội dung gửi lên không phải JSON hợp lệ.");
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on("error", () => {
      if (settled) return;
      settled = true;
      const err = new Error("Không đọc được dữ liệu yêu cầu.");
      err.statusCode = 400;
      reject(err);
    });
  });
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function pruneCacheIfNeeded() {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp >= CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

async function fetchAccessTradeTransactions(since, until, accessKey) {
  const allItems = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const upstreamUrl = new URL(AT_BASE + "/v1/transactions");
    upstreamUrl.searchParams.set("since", since);
    upstreamUrl.searchParams.set("until", until);
    upstreamUrl.searchParams.set("limit", String(PAGE_LIMIT));
    upstreamUrl.searchParams.set("page", String(page));

    let response;
    try {
      response = await fetch(upstreamUrl.toString(), {
        method: "GET",
        headers: {
          Authorization: "Token " + accessKey,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
    } catch (networkErr) {
      const msg =
        networkErr && networkErr.name === "TimeoutError"
          ? "Kết nối tới AccessTrade bị quá thời gian."
          : "Không thể kết nối tới máy chủ AccessTrade.";
      const err = new Error(msg);
      err.statusCode = 502;
      throw err;
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const authErr = new Error(
          "Access Key không hợp lệ hoặc không có quyền truy cập (HTTP " +
            response.status +
            "). Vui lòng kiểm tra lại tại pub.accesstrade.vn."
        );
        authErr.statusCode = 502;
        throw authErr;
      }
      if (response.status === 429) {
        const rateErr = new Error(
          "Vượt quá giới hạn 10 lượt/phút của AccessTrade (HTTP 429). Vui lòng thử lại sau 1 phút."
        );
        rateErr.statusCode = 502;
        throw rateErr;
      }

      let detail = "HTTP " + response.status;
      try {
        const errBody = await response.json();
        if (errBody && typeof errBody.message === "string" && errBody.message.trim()) {
          detail += " - " + errBody.message.trim();
        }
      } catch (_ignore) {
        // Không đọc được JSON lỗi từ upstream
      }
      const err = new Error("AccessTrade trả về lỗi (" + detail + ").");
      err.statusCode = 502;
      throw err;
    }

    let body;
    try {
      body = await response.json();
    } catch (_parseErr) {
      const err = new Error("Phản hồi từ AccessTrade không phải JSON hợp lệ.");
      err.statusCode = 502;
      throw err;
    }

    const pageItems = Array.isArray(body && body.data) ? body.data : [];
    for (let i = 0; i < pageItems.length; i += 1) {
      allItems.push(pageItems[i]);
    }

    if (pageItems.length < PAGE_LIMIT) {
      break;
    }
  }

  return allItems;
}

async function getCachedTransactions(since, until, accessKey) {
  const cacheKey = since + "|" + until + "|" + hashKey(accessKey);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const data = await fetchAccessTradeTransactions(since, until, accessKey);
      pruneCacheIfNeeded();
      cache.set(cacheKey, {
        timestamp: Date.now(),
        data
      });
      return data;
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  return promise;
}

async function createAccessTradeTrackingLink({ campaignId, targetUrl, accessKey, extraSubs }) {
  const payload = {
    campaign_id: campaignId
  };
  if (targetUrl) {
    payload.urls = [targetUrl];
  }
  if (extraSubs && typeof extraSubs === "object") {
    for (const subKey of ["sub1", "sub2", "sub3", "sub4"]) {
      const subVal = typeof extraSubs[subKey] === "string" ? extraSubs[subKey].trim() : "";
      if (subVal) {
        payload[subKey] = subVal;
      }
    }
  }

  let response;
  try {
    response = await fetch(AT_BASE + "/v1/product_link/create", {
      method: "POST",
      headers: {
        Authorization: "Token " + accessKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (networkErr) {
    const msg =
      networkErr && networkErr.name === "TimeoutError"
        ? "Kết nối tới AccessTrade bị quá thời gian."
        : "Không thể kết nối tới máy chủ AccessTrade.";
    const err = new Error(msg);
    err.statusCode = 502;
    throw err;
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      const authErr = new Error(
        "Access Key không hợp lệ hoặc không có quyền tạo link (HTTP " +
          response.status +
          "). Vui lòng kiểm tra lại tại pub.accesstrade.vn."
      );
      authErr.statusCode = 502;
      throw authErr;
    }
    if (response.status === 429) {
      const rateErr = new Error(
        "Vượt quá giới hạn lượt gọi API của AccessTrade (HTTP 429). Vui lòng thử lại sau 1 phút."
      );
      rateErr.statusCode = 502;
      throw rateErr;
    }

    let detail = "HTTP " + response.status;
    try {
      const errBody = await response.json();
      if (errBody && typeof errBody.message === "string" && errBody.message.trim()) {
        detail += " - " + errBody.message.trim();
      }
    } catch (_ignore) {
      // Không đọc được JSON lỗi từ upstream
    }
    const err = new Error("AccessTrade trả về lỗi khi tạo link (" + detail + ").");
    err.statusCode = 502;
    throw err;
  }

  let body;
  try {
    body = await response.json();
  } catch (_parseErr) {
    const err = new Error("Phản hồi tạo link từ AccessTrade không phải JSON hợp lệ.");
    err.statusCode = 502;
    throw err;
  }

  const data = body && body.data ? body.data : {};
  const successList = Array.isArray(data.success_link) ? data.success_link : [];
  if (successList.length > 0 && successList[0] && typeof successList[0].aff_link === "string") {
    return {
      aff_link: successList[0].aff_link,
      short_link: typeof successList[0].short_link === "string" ? successList[0].short_link : "",
      url_origin: typeof successList[0].url_origin === "string" ? successList[0].url_origin : ""
    };
  }

  const suspendList = Array.isArray(data.suspend_url) ? data.suspend_url : [];
  if (suspendList.length > 0) {
    const suspendErr = new Error(
      "Link đích hoặc chiến dịch này đang bị tạm ngưng tạo link trên AccessTrade."
    );
    suspendErr.statusCode = 502;
    throw suspendErr;
  }

  const errorList = Array.isArray(data.error_link) ? data.error_link : [];
  const msg =
    errorList.length > 0
      ? "AccessTrade không tạo được link cho chiến dịch/URL này. Hãy kiểm tra xem tài khoản đã đăng ký và được duyệt chiến dịch chưa."
      : typeof body.message === "string" && body.message.trim()
      ? body.message.trim()
      : "AccessTrade không trả về aff_link cho chiến dịch này.";
  const failErr = new Error(msg);
  failErr.statusCode = 502;
  throw failErr;
}

function getAllowedShortenerUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_err) {
    const err = new Error("Link rút gọn không hợp lệ.");
    err.statusCode = 400;
    throw err;
  }

  const host = parsed.hostname.toLowerCase();
  if (SHORTENER_TEST_BASE) {
    const testParsed = new URL(SHORTENER_TEST_BASE);
    if (parsed.origin === testParsed.origin) {
      return parsed;
    }
    if (ALLOWED_SHORTENER_HOSTS.has(host)) {
      return new URL(parsed.pathname + parsed.search, testParsed.origin);
    }
  }

  if (parsed.protocol !== "https:") {
    const protoErr = new Error("Link rút gọn phải sử dụng giao thức https://.");
    protoErr.statusCode = 400;
    throw protoErr;
  }
  if (!ALLOWED_SHORTENER_HOSTS.has(host)) {
    const hostErr = new Error(
      "Chỉ hỗ trợ giải mã link rút gọn của AccessTrade (shorten.asia, rutgon.me, s.isclix.com)."
    );
    hostErr.statusCode = 400;
    throw hostErr;
  }
  return parsed;
}

function isTrackedBridgePath(pathname) {
  return /^\/l\/([a-z0-9]{4,20})\/?$/i.test(String(pathname || ""));
}

function isAllowedTrackedBridgeHost(urlObj, allowedOrigin) {
  if (!urlObj || !isTrackedBridgePath(urlObj.pathname)) return false;
  if (SHORTENER_TEST_BASE) {
    try {
      const testParsed = new URL(SHORTENER_TEST_BASE);
      if (urlObj.origin === testParsed.origin) return true;
    } catch (_e) {
      // Bỏ qua
    }
  }
  if (allowedOrigin) {
    try {
      const allowedParsed = new URL(allowedOrigin);
      if (urlObj.origin === allowedParsed.origin) return true;
    } catch (_e) {
      // Bỏ qua
    }
  }
  const cfgViewBase =
    bridgeState && bridgeState.ctvLinkConfig && typeof bridgeState.ctvLinkConfig.viewBase === "string"
      ? bridgeState.ctvLinkConfig.viewBase.trim()
      : "";
  if (cfgViewBase) {
    try {
      const cfgParsed = new URL(cfgViewBase);
      if (urlObj.origin === cfgParsed.origin) return true;
    } catch (_e) {
      // Bỏ qua
    }
  }
  return false;
}

async function resolveAccessTradeShortLink(rawUrl, allowedOrigin) {
  let currentUrlObj = getAllowedShortenerUrl(rawUrl);

  for (let hop = 0; hop < MAX_SHORTENER_HOPS; hop += 1) {
    let response;
    try {
      response = await fetch(currentUrlObj.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0",
          Purpose: "prefetch"
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
    } catch (networkErr) {
      const msg =
        networkErr && networkErr.name === "TimeoutError"
          ? "Giải mã link rút gọn bị quá thời gian."
          : "Không thể kết nối tới dịch vụ link rút gọn.";
      const err = new Error(msg);
      err.statusCode = 502;
      throw err;
    }

    if (response.body && typeof response.body.cancel === "function") {
      response.body.cancel().catch(() => {});
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        const noLocErr = new Error("Link rút gọn không trả về địa chỉ chuyển hướng.");
        noLocErr.statusCode = 502;
        throw noLocErr;
      }
      const nextUrlObj = new URL(location, currentUrlObj);
      if (isAccessTradeTrackingHost(nextUrlObj.hostname)) {
        return {
          resolved_url: nextUrlObj.toString(),
          hops: hop + 1
        };
      }
      if (isAllowedTrackedBridgeHost(nextUrlObj, allowedOrigin)) {
        currentUrlObj = nextUrlObj;
        continue;
      }
      currentUrlObj = getAllowedShortenerUrl(nextUrlObj.toString());
      continue;
    }

    const noRedirErr = new Error(
      "Link rút gọn này không chuyển hướng tới link tracking AccessTrade (HTTP " + response.status + ")."
    );
    noRedirErr.statusCode = 502;
    throw noRedirErr;
  }

  const hopErr = new Error("Link rút gọn chuyển hướng quá nhiều lần.");
  hopErr.statusCode = 502;
  throw hopErr;
}

function resolveBrandShortPrefix(projectKey) {
  const raw = String(projectKey || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "tnex") return "Tnex";
  if (raw === "vietcredit") return "VietCredit";
  const cleaned = raw.replace(/[^a-z0-9]/gi, "");
  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1, 14);
}

function buildIsGdCustomAlias(projectKey) {
  const prefix = resolveBrandShortPrefix(projectKey);
  if (!prefix) return "";
  const suffix = crypto.randomBytes(4).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 6);
  const safeSuffix = suffix.length >= 4 ? suffix : crypto.randomBytes(3).toString("hex");
  const combined = prefix + "_" + safeSuffix;
  return combined.slice(0, 30);
}

async function requestIsGdCreate(endpoint) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "DasboardFin/1.0" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (networkErr) {
    const msg =
      networkErr && networkErr.name === "TimeoutError"
        ? "Kết nối tới is.gd bị quá thời gian."
        : "Không thể kết nối tới dịch vụ rút gọn is.gd.";
    const err = new Error(msg);
    err.statusCode = 502;
    err.isNetwork = true;
    throw err;
  }

  let data = null;
  try {
    data = await response.json();
  } catch (_e) {
    data = null;
  }
  return { response, data };
}

async function shortenViaIsGd(fullUrl, projectKey = "") {
  const baseEndpoint = ISGD_API_BASE + "/create.php?format=json&url=" + encodeURIComponent(fullUrl);
  const brandPrefix = resolveBrandShortPrefix(projectKey);

  if (brandPrefix) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const alias = buildIsGdCustomAlias(projectKey);
      const customEndpoint = baseEndpoint + "&shorturl=" + encodeURIComponent(alias);
      const { response, data } = await requestIsGdCreate(customEndpoint);
      if (response.ok && data && typeof data.shorturl === "string" && /^https?:\/\//i.test(data.shorturl)) {
        return {
          short_url: data.shorturl.trim(),
          provider: "isgd",
          provider_label: "is.gd (" + brandPrefix + ")"
        };
      }
      const errMsgLower = String((data && data.errormessage) || "").toLowerCase();
      const isAliasCollision = (data && Number(data.errorcode) === 2) || errMsgLower.includes("already exists");
      if (!isAliasCollision) {
        break;
      }
    }
  }

  const { response, data } = await requestIsGdCreate(baseEndpoint);
  if (response.ok && data && typeof data.shorturl === "string" && /^https?:\/\//i.test(data.shorturl)) {
    return {
      short_url: data.shorturl.trim(),
      provider: "isgd",
      provider_label: "is.gd"
    };
  }

  const upstreamErr =
    data && typeof data.errormessage === "string" && data.errormessage.trim()
      ? data.errormessage.trim()
      : "HTTP " + response.status;
  const err = new Error("Dịch vụ rút gọn is.gd trả về lỗi (" + upstreamErr + ").");
  err.statusCode = 502;
  throw err;
}

async function shortenViaTinyUrl(fullUrl) {
  const endpoint = TINYURL_API_BASE + "/api-create.php?url=" + encodeURIComponent(fullUrl);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { "User-Agent": "DasboardFin/1.0" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (networkErr) {
    const msg =
      networkErr && networkErr.name === "TimeoutError"
        ? "Kết nối tới tinyurl.com bị quá thời gian."
        : "Không thể kết nối tới dịch vụ rút gọn tinyurl.com.";
    const err = new Error(msg);
    err.statusCode = 502;
    throw err;
  }

  const text = (await response.text().catch(() => "")).trim();
  if (response.ok && /^https?:\/\/(www\.)?tinyurl\.com\/[A-Za-z0-9_-]+$/i.test(text)) {
    return {
      short_url: text,
      provider: "tinyurl",
      provider_label: "TinyURL"
    };
  }

  const err = new Error("Dịch vụ rút gọn TinyURL trả về lỗi (HTTP " + response.status + ").");
  err.statusCode = 502;
  throw err;
}

function checkAffLinkCarriesSub(affLink, subField, subValue) {
  if (!subValue) return true;
  try {
    const parsed = new URL(affLink);
    return parsed.searchParams.get(subField) === subValue;
  } catch (_e) {
    return false;
  }
}

async function shortenViaAccessTrade({ campaignId, targetUrl, subField, subValue, fullUrlObj, accessKey }) {
  const extraSubs = {};
  for (const key of ["sub1", "sub2", "sub3", "sub4"]) {
    const existingVal = fullUrlObj.searchParams.get(key);
    if (existingVal) extraSubs[key] = existingVal;
  }
  if (subValue) {
    extraSubs[subField] = subValue;
  }

  const created = await createAccessTradeTrackingLink({
    campaignId,
    targetUrl,
    accessKey,
    extraSubs
  });

  if (!created.short_link || !/^https?:\/\//i.test(created.short_link)) {
    const noShortErr = new Error("AccessTrade không trả về short_link cho chiến dịch này.");
    noShortErr.statusCode = 502;
    throw noShortErr;
  }

  if (!checkAffLinkCarriesSub(created.aff_link, subField, subValue)) {
    const noSubErr = new Error(
      "Link rút gọn AccessTrade chưa gắn tham số " + subField + "=" + subValue + "."
    );
    noSubErr.statusCode = 502;
    throw noSubErr;
  }

  return {
    short_url: created.short_link,
    aff_link: created.aff_link,
    provider: "accesstrade",
    provider_label: "AccessTrade (" + new URL(created.short_link).hostname + ")"
  };
}

function extractRefFromTrackedUrlObj(urlObj) {
  if (!urlObj) return "";
  const m = String(urlObj.pathname || "").match(/^\/l\/([a-z0-9_]{3,40})(?:\/([a-z0-9_-]{2,30}))?\/?$/i);
  return m ? m[1] : "";
}

function extractProjectFromTrackedUrlObj(urlObj) {
  if (!urlObj) return "";
  const m = String(urlObj.pathname || "").match(/^\/l\/([a-z0-9_]{3,40})(?:\/([a-z0-9_-]{2,30}))?\/?$/i);
  if (m && m[2]) return m[2].toLowerCase();
  const qProj = (urlObj.searchParams.get("p") || urlObj.searchParams.get("project") || "").trim().toLowerCase();
  return qProj;
}

async function createShortTrackingLink({
  fullUrl,
  provider,
  campaignId,
  targetUrl,
  subField,
  subValue,
  projectKey,
  accessKey
}) {
  let fullUrlObj;
  try {
    fullUrlObj = new URL(fullUrl);
  } catch (_e) {
    const urlErr = new Error("Link bán hàng gốc không hợp lệ.");
    urlErr.statusCode = 400;
    throw urlErr;
  }

  if (fullUrlObj.protocol !== "https:" && fullUrlObj.protocol !== "http:") {
    const protoErr = new Error("Link bán hàng gốc phải bắt đầu bằng https:// hoặc http://.");
    protoErr.statusCode = 400;
    throw protoErr;
  }

  const isAtTracking = isAccessTradeTrackingHost(fullUrlObj.hostname);
  const trackedRefInPath = extractRefFromTrackedUrlObj(fullUrlObj);
  const isTrackedBridgeUrl = Boolean(trackedRefInPath);

  if (!isAtTracking && !isTrackedBridgeUrl) {
    const hostErr = new Error(
      "Chỉ hỗ trợ rút gọn link tracking AccessTrade (go.isclix.com / click.accesstrade.vn) hoặc link đếm nhấp (/l/<mã>)."
    );
    hostErr.statusCode = 400;
    throw hostErr;
  }

  if (isAtTracking && subValue && fullUrlObj.searchParams.get(subField) !== subValue) {
    const mismatchErr = new Error(
      "Link đầy đủ chưa chứa đúng tham số " + subField + "=" + subValue + "."
    );
    mismatchErr.statusCode = 400;
    throw mismatchErr;
  }

  if (isTrackedBridgeUrl) {
    if (subValue && trackedRefInPath.toLowerCase() !== subValue.toLowerCase()) {
      const refMismatchErr = new Error(
        "Link đếm lượt nhấp (/l/...) chưa khớp mã CTV " + subValue + "."
      );
      refMismatchErr.statusCode = 400;
      throw refMismatchErr;
    }
    const hostLower = fullUrlObj.hostname.toLowerCase();
    const isLoopback = hostLower === "localhost" || hostLower === "127.0.0.1";
    if (fullUrlObj.protocol !== "https:" && !isLoopback && !SHORTENER_TEST_BASE) {
      const bridgeProtoErr = new Error("Link đếm lượt nhấp phải dùng giao thức https:// để rút gọn.");
      bridgeProtoErr.statusCode = 400;
      throw bridgeProtoErr;
    }
  }

  const normalizedProvider =
    provider === "accesstrade" || provider === "isgd" || provider === "tinyurl"
      ? provider
      : "auto";
  const effectiveProjectKey =
    String(projectKey || "").trim().toLowerCase() || extractProjectFromTrackedUrlObj(fullUrlObj);

  if (normalizedProvider === "accesstrade") {
    if (isTrackedBridgeUrl) {
      const atBridgeErr = new Error(
        "Chế độ rút gọn chính chủ AccessTrade (shorten.asia) đi thẳng qua AccessTrade nên không qua link /l/<mã>. Hãy chọn 'Tự động' hoặc 'is.gd'."
      );
      atBridgeErr.statusCode = 400;
      throw atBridgeErr;
    }
    if (!accessKey) {
      const noKeyErr = new Error(
        "Cần dán Access Key trong mục Cài đặt để tạo link rút gọn chính chủ AccessTrade (shorten.asia)."
      );
      noKeyErr.statusCode = 400;
      throw noKeyErr;
    }
    if (!/^\d{4,30}$/.test(campaignId)) {
      const noCampErr = new Error(
        "Cần có Mã chiến dịch (dãy số) hợp lệ để gọi API rút gọn AccessTrade."
      );
      noCampErr.statusCode = 400;
      throw noCampErr;
    }
    const atRes = await shortenViaAccessTrade({
      campaignId,
      targetUrl,
      subField,
      subValue,
      fullUrlObj,
      accessKey
    });
    return {
      short_url: atRes.short_url,
      provider: atRes.provider,
      provider_label: atRes.provider_label,
      full_url: atRes.aff_link || fullUrlObj.toString(),
      sub_field: subField,
      sub_value: subValue,
      verified_tracking: true
    };
  }

  if (normalizedProvider === "isgd") {
    const isgdRes = await shortenViaIsGd(fullUrlObj.toString(), effectiveProjectKey);
    return {
      short_url: isgdRes.short_url,
      provider: isgdRes.provider,
      provider_label: isgdRes.provider_label,
      full_url: fullUrlObj.toString(),
      sub_field: subField,
      sub_value: subValue,
      verified_tracking: true
    };
  }

  if (normalizedProvider === "tinyurl") {
    const tinyRes = await shortenViaTinyUrl(fullUrlObj.toString());
    return {
      short_url: tinyRes.short_url,
      provider: tinyRes.provider,
      provider_label: tinyRes.provider_label,
      full_url: fullUrlObj.toString(),
      sub_field: subField,
      sub_value: subValue,
      verified_tracking: true
    };
  }

  // Chế độ "auto": nếu có projectKey (muốn gắn thương hiệu) hoặc là link /l/<mã> thì dùng is.gd để giữ thương hiệu/tracking; ngược lại ưu tiên shorten.asia nếu có key
  if (!effectiveProjectKey && isAtTracking && accessKey && /^\d{4,30}$/.test(campaignId)) {
    try {
      const atAutoRes = await shortenViaAccessTrade({
        campaignId,
        targetUrl,
        subField,
        subValue,
        fullUrlObj,
        accessKey
      });
      return {
        short_url: atAutoRes.short_url,
        provider: atAutoRes.provider,
        provider_label: atAutoRes.provider_label,
        full_url: atAutoRes.aff_link || fullUrlObj.toString(),
        sub_field: subField,
        sub_value: subValue,
        verified_tracking: true
      };
    } catch (_ignoreAtAutoErr) {
      // Nếu AccessTrade API lỗi hoặc không giữ sub2, fallback an toàn sang is.gd với full_url đã có sẵn sub2
    }
  }

  try {
    const isgdAuto = await shortenViaIsGd(fullUrlObj.toString(), effectiveProjectKey);
    return {
      short_url: isgdAuto.short_url,
      provider: isgdAuto.provider,
      provider_label: isgdAuto.provider_label,
      full_url: fullUrlObj.toString(),
      sub_field: subField,
      sub_value: subValue,
      verified_tracking: true
    };
  } catch (_isgdErr) {
    const tinyAuto = await shortenViaTinyUrl(fullUrlObj.toString());
    return {
      short_url: tinyAuto.short_url,
      provider: tinyAuto.provider,
      provider_label: tinyAuto.provider_label,
      full_url: fullUrlObj.toString(),
      sub_field: subField,
      sub_value: subValue,
      verified_tracking: true
    };
  }
}

function serveHtmlFile(res, filePath, missingMsg) {
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      sendJson(res, 500, { error: missingMsg });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(html);
  });
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || "local";
}

function checkViewRateLimit(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxHits = 60;
  let entry = viewRateMap.get(ip);
  if (!entry || now - entry.windowStart >= windowMs) {
    entry = { windowStart: now, count: 1 };
    if (viewRateMap.size > 500) viewRateMap.clear();
    viewRateMap.set(ip, entry);
    return true;
  }
  entry.count += 1;
  return entry.count <= maxHits;
}

function normalizeRiskTier(rawVal) {
  const s = String(rawVal || "").trim().toLowerCase();
  if (s === "low" || s === "medium" || s === "high") return s;
  return "";
}

function normalizeCtvFieldServer(rawVal) {
  const s = String(rawVal || "").trim().toLowerCase();
  return s === "sub1" || s === "sub2" || s === "sub3" || s === "sub4" ? s : "sub2";
}

function mapServerLeadStatus(statusVal, confirmedVal) {
  const statusNum = Number(statusVal);
  const isConfirmed =
    confirmedVal === true ||
    Number(confirmedVal) === 1 ||
    String(confirmedVal).toLowerCase() === "true";
  if (statusNum === 2) return "cancelled";
  if (statusNum === 1 && isConfirmed) return "confirmed";
  if (statusNum === 1) return "approved";
  return "pending";
}

function mapViewOrderStatus(statusKey) {
  if (statusKey === "confirmed" || statusKey === "reconciled") return "reconciled";
  if (statusKey === "approved") return "approved";
  if (statusKey === "cancelled") return "cancelled";
  return "pending";
}

function formatServerYmdGmt7(dateObj) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(dateObj);
}

function resolveRequestOrigin(req) {
  const rawProto = req.headers["x-forwarded-proto"];
  const protoHeader = typeof rawProto === "string" ? rawProto.split(",")[0].trim().toLowerCase() : "";
  const rawHost = req.headers["x-forwarded-host"] || req.headers["host"] || "";
  const host = typeof rawHost === "string" ? rawHost.split(",")[0].trim() : "";
  if (!host) return "";
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const proto = protoHeader === "https" || protoHeader === "http" ? protoHeader : isLocal ? "http" : "https";
  return proto + "://" + host;
}

function getTrackedBaseUrl(cfg, reqOrigin) {
  const rawVb = cfg && typeof cfg.viewBase === "string" ? cfg.viewBase.trim().replace(/\/+$/, "") : "";
  if (rawVb) {
    try {
      const parsed = new URL(rawVb);
      const h = parsed.hostname.toLowerCase();
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        !isAccessTradeTrackingHost(h) &&
        !ALLOWED_SHORTENER_HOSTS.has(h) &&
        h !== "ten-mien-cua-ban.com" &&
        h !== "example.com"
      ) {
        return parsed.origin + (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""));
      }
    } catch (_e) {
      // Fallback sang reqOrigin
    }
  }
  return reqOrigin || "";
}

function isAllowedOutboundSalesHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  return isAccessTradeTrackingHost(host) || ALLOWED_SHORTENER_HOSTS.has(host);
}

function isRealHumanClickRequest(req) {
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET") return false;
  const purpose = String(req.headers["purpose"] || "").toLowerCase();
  const secPurpose = String(req.headers["sec-purpose"] || "").toLowerCase();
  const xMoz = String(req.headers["x-moz"] || "").toLowerCase();
  if (
    purpose === "prefetch" ||
    secPurpose.includes("prefetch") ||
    secPurpose.includes("preview") ||
    xMoz === "prefetch"
  ) {
    return false;
  }
  const ua = String(req.headers["user-agent"] || "");
  if (
    /(facebookexternalhit|facebot|zalopc|zalo\/|zalobot|zalo-bot|telegrambot|slackbot|whatsapp|discordbot|googlebot|bingbot|twitterbot|linkedinbot|applebot|\bbot\b|\bcrawler\b|\bspider\b)/i.test(
      ua
    )
  ) {
    return false;
  }
  return true;
}

function recordRealClick(ref) {
  if (!/^[a-z0-9_]{3,40}$/i.test(String(ref || ""))) return null;
  if (!bridgeState.clickStats || typeof bridgeState.clickStats !== "object") {
    bridgeState.clickStats = {};
  }
  const todayKey = formatServerYmdGmt7(new Date());
  const prev =
    bridgeState.clickStats[ref] && typeof bridgeState.clickStats[ref] === "object"
      ? bridgeState.clickStats[ref]
      : { total: 0, byDay: {}, lastClickAt: "" };
  const nextByDay = prev.byDay && typeof prev.byDay === "object" ? { ...prev.byDay } : {};
  nextByDay[todayKey] = (Math.max(0, Math.round(Number(nextByDay[todayKey]) || 0))) + 1;

  const sortedDays = Object.keys(nextByDay).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  while (sortedDays.length > 45) {
    const oldest = sortedDays.shift();
    if (oldest) delete nextByDay[oldest];
  }

  const updated = {
    total: Math.max(0, Math.round(Number(prev.total) || 0)) + 1,
    byDay: nextByDay,
    lastClickAt: new Date().toISOString()
  };
  bridgeState.clickStats[ref] = updated;
  saveBridgeStateToDisk();
  if (bridgeState.mode !== "demo") {
    recordClickInSupabase(ref).catch(() => {});
  }
  return updated;
}

function getClickSummaryForRef(ref) {
  const statsMap = bridgeState.clickStats && typeof bridgeState.clickStats === "object" ? bridgeState.clickStats : {};
  const entry = statsMap[ref];
  if (!entry || typeof entry !== "object") {
    return { total: 0, today: 0, lastClickAt: "" };
  }
  const todayKey = formatServerYmdGmt7(new Date());
  const byDay = entry.byDay && typeof entry.byDay === "object" ? entry.byDay : {};
  return {
    total: Math.max(0, Math.round(Number(entry.total) || 0)),
    today: Math.max(0, Math.round(Number(byDay[todayKey]) || 0)),
    lastClickAt: typeof entry.lastClickAt === "string" ? entry.lastClickAt : ""
  };
}

function buildClicksSummaryMap() {
  const out = {};
  const seen = new Set();
  if (Array.isArray(bridgeState.ctvList)) {
    for (const c of bridgeState.ctvList) {
      if (c && c.ref) seen.add(c.ref);
    }
  }
  if (bridgeState.clickStats && typeof bridgeState.clickStats === "object") {
    for (const k of Object.keys(bridgeState.clickStats)) {
      seen.add(k);
    }
  }
  for (const ref of seen) {
    if (/^[a-z0-9_]{3,40}$/i.test(ref)) {
      out[ref] = getClickSummaryForRef(ref);
    }
  }
  return out;
}

function isAllowedClientSalesUrl(urlStr) {
  if (typeof urlStr !== "string" || !urlStr) return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol === "https:") return true;
    const h = parsed.hostname.toLowerCase();
    return parsed.protocol === "http:" && (h === "localhost" || h === "127.0.0.1");
  } catch (_e) {
    return false;
  }
}

function getProjectConfig(cfg, projectKey) {
  if (!cfg || typeof cfg !== "object") return null;
  const projects = cfg.projects && typeof cfg.projects === "object" ? cfg.projects : {};
  const pKey = String(projectKey || "").trim().toLowerCase();
  if (pKey) {
    return projects[pKey] && typeof projects[pKey] === "object" ? projects[pKey] : null;
  }
  const defKey = String(cfg.defaultProject || "vietcredit").trim().toLowerCase();
  if (projects[defKey] && typeof projects[defKey] === "object") {
    return projects[defKey];
  }
  return projects["vietcredit"] || null;
}

function buildFallbackFullSalesLink(cfg, ref, ctvField, projectKey) {
  const pKey = String(projectKey || "").trim().toLowerCase();
  const pCfg = getProjectConfig(cfg, pKey);
  // Nếu yêu cầu dự án cụ thể (như tnex) thì chỉ dùng pCfg, tuyệt đối KHÔNG fallback sang VietCredit
  let effectiveCfg;
  if (pKey && pKey !== "vietcredit") {
    effectiveCfg = pCfg;
  } else {
    effectiveCfg = pCfg || cfg || {};
  }
  if (!effectiveCfg) return "";

  const field = normalizeCtvFieldServer(ctvField);
  const baseSalesLink = typeof effectiveCfg.baseSalesLink === "string" ? effectiveCfg.baseSalesLink.trim() : "";
  if (baseSalesLink) {
    try {
      const u = new URL(baseSalesLink);
      if (field !== "sub2") {
        u.searchParams.delete("sub2");
      }
      u.searchParams.set(field, ref);
      return u.toString();
    } catch (_e) {
      return "";
    }
  }
  const pub = typeof effectiveCfg.publisher === "string" ? effectiveCfg.publisher.trim() : "";
  const camp = typeof effectiveCfg.campaign === "string" ? effectiveCfg.campaign.trim() : "";
  const target = typeof effectiveCfg.targetUrl === "string" ? effectiveCfg.targetUrl.trim() : "";
  if (/^\d{4,30}$/.test(pub) && /^\d{4,30}$/.test(camp) && target) {
    try {
      const targetCheck = new URL(target);
      if (targetCheck.protocol === "https:" || targetCheck.protocol === "http:") {
        return (
          "https://go.isclix.com/deep_link/" +
          encodeURIComponent(pub) +
          "/" +
          encodeURIComponent(camp) +
          "?url=" +
          encodeURIComponent(target) +
          "&" +
          encodeURIComponent(field) +
          "=" +
          encodeURIComponent(ref)
        );
      }
    } catch (_err) {
      return "";
    }
  }
  return "";
}

function findSalesLinkForCtv(ctv, reqOrigin, projectKey) {
  const cfg = bridgeState.ctvLinkConfig || {};
  const field = normalizeCtvFieldServer(bridgeState.policy && bridgeState.policy.ctvField);
  const fullUrl = buildFallbackFullSalesLink(cfg, ctv.ref, field, projectKey);

  const pKey = String(projectKey || "").trim().toLowerCase();
  // Nếu dự án yêu cầu chưa được cấu hình hợp lệ thì trả về rỗng, không sinh link lỗi
  if (pKey && pKey !== "vietcredit" && !fullUrl) {
    return "";
  }

  const trackedBase = getTrackedBaseUrl(cfg, reqOrigin);
  const projectPathSuffix = pKey && pKey !== "vietcredit" ? "/" + encodeURIComponent(pKey) : "";
  const trackedUrl = trackedBase ? trackedBase.replace(/\/+$/, "") + "/l/" + encodeURIComponent(ctv.ref) + projectPathSuffix : "";

  const mode = typeof cfg.salesLinkMode === "string" && cfg.salesLinkMode ? cfg.salesLinkMode : "short_auto";
  const cacheMap = bridgeState.ctvShortLinks || {};

  if (cfg.trackClicks === true && mode !== "short_accesstrade") {
    if (trackedUrl && isAllowedClientSalesUrl(trackedUrl)) {
      if (mode !== "full") {
        const cacheLookupKey = mode + "|" + (pKey ? pKey + "|" : "") + trackedUrl;
        const trackedCacheEntry = cacheMap[cacheLookupKey] || cacheMap[mode + "|" + trackedUrl];
        if (
          trackedCacheEntry &&
          typeof trackedCacheEntry.shortUrl === "string" &&
          isAllowedClientSalesUrl(trackedCacheEntry.shortUrl)
        ) {
          return trackedCacheEntry.shortUrl;
        }
        for (const key of Object.keys(cacheMap)) {
          const entry = cacheMap[key];
          if (
            entry &&
            typeof entry.shortUrl === "string" &&
            isAllowedClientSalesUrl(entry.shortUrl) &&
            entry.fullUrl === trackedUrl
          ) {
            return entry.shortUrl;
          }
        }
      }
      return trackedUrl;
    }
  }

  if (fullUrl && fullUrl.startsWith("https://")) {
    const exactLookupKey = mode + "|" + (pKey ? pKey + "|" : "") + fullUrl;
    const exactEntry = cacheMap[exactLookupKey] || cacheMap[mode + "|" + fullUrl];
    if (exactEntry && typeof exactEntry.shortUrl === "string" && exactEntry.shortUrl.startsWith("https://")) {
      return exactEntry.shortUrl;
    }

    for (const key of Object.keys(cacheMap)) {
      const entry = cacheMap[key];
      if (
        entry &&
        typeof entry.shortUrl === "string" &&
        entry.shortUrl.startsWith("https://") &&
        typeof entry.fullUrl === "string" &&
        entry.fullUrl.includes(field + "=" + ctv.ref)
      ) {
        return entry.shortUrl;
      }
    }

    return fullUrl;
  }

  // Fallback cuối: link tracking bridge /l/<ref> dùng reqOrigin
  if (trackedUrl) return trackedUrl;
  return reqOrigin ? reqOrigin.replace(/\/+$/, "") + "/l/" + encodeURIComponent(ctv.ref) + projectPathSuffix : "";
}

function normalizeServerRawTransaction(raw, idx) {
  const item = raw && typeof raw === "object" ? raw : {};
  const id =
    item.conversion_id != null && item.conversion_id !== ""
      ? String(item.conversion_id)
      : item.id != null && item.id !== ""
      ? String(item.id)
      : "HS-" + (idx + 1);
  const campaign =
    item.merchant ||
    item.campaign_name ||
    (item.campaign_id != null && item.campaign_id !== ""
      ? "Chiến dịch #" + item.campaign_id
      : "Sản phẩm tài chính");
  const extra = item._extra && typeof item._extra === "object" ? item._extra : {};
  const pickSub = (a, b) =>
    a != null && String(a).trim() !== ""
      ? String(a).trim()
      : b != null && String(b).trim() !== ""
      ? String(b).trim()
      : "";
  const subs = {
    sub1: pickSub(item.sub1, extra.sub1),
    sub2: pickSub(item.sub2, extra.sub2),
    sub3: pickSub(item.sub3, extra.sub3),
    sub4: pickSub(item.sub4, extra.sub4)
  };
  return {
    conversionId: id,
    campaignName: String(campaign),
    timeRaw: String(item.transaction_time || item.sales_time || item.click_time || ""),
    commission: Number.isFinite(Number(item.commission)) ? Number(item.commission) : 0,
    statusKey: mapServerLeadStatus(item.status, item.is_confirmed),
    subs,
    apiRiskLevel:
      normalizeRiskTier(item.risk_level) ||
      normalizeRiskTier(item.risk) ||
      normalizeRiskTier(item.risk_tier)
  };
}

function normalizeConversionRowToLead(row) {
  const subs = row && row.tracking && typeof row.tracking === "object" ? row.tracking : {};
  const sub2 = row.sub2 != null ? String(row.sub2).trim() : (typeof subs.sub2 === "string" ? subs.sub2.trim() : "");
  const utmCampaign = row.utm_campaign != null ? String(row.utm_campaign).trim() : (typeof subs.utm_campaign === "string" ? subs.utm_campaign.trim() : "");
  return {
    conversionId: String(row.conversion_id || ""),
    orderId: String(row.order_id || row.conversion_id || ""),
    orderValue: Number.isFinite(Number(row.order_value)) ? Number(row.order_value) : 0,
    campaignName: String(row.advertiser || "Sản phẩm tài chính"),
    timeRaw: String(row.sales_time || row.update_time || ""),
    commission: Number.isFinite(Number(row.commission)) ? Number(row.commission) : 0,
    statusKey: mapServerLeadStatus(row.status, row.is_confirmed),
    ctvRef: row.ctv_ref ? String(row.ctv_ref).trim().toLowerCase() : (sub2 || utmCampaign).toLowerCase(),
    subs: {
      sub1: typeof subs.sub1 === "string" ? subs.sub1.trim() : "",
      sub2,
      sub3: typeof subs.sub3 === "string" ? subs.sub3.trim() : "",
      sub4: typeof subs.sub4 === "string" ? subs.sub4.trim() : "",
      utm_campaign: utmCampaign
    },
    apiRiskLevel: ""
  };
}

async function buildCtvViewPayload(ctv, reqOrigin) {
  // Nạp settings mới nhất từ Supabase để đảm bảo ctvLinkConfig, policy và accessKey luôn được đồng bộ
  if (bridgeState.mode !== "demo") {
    try {
      const freshSettings = await getSettingsFromSupabase();
      if (freshSettings) {
        if (freshSettings.ctvLinkConfig) bridgeState.ctvLinkConfig = mergeCtvLinkConfigs(bridgeState.ctvLinkConfig, freshSettings.ctvLinkConfig, false);
        if (freshSettings.policy) bridgeState.policy = { ...bridgeState.policy, ...freshSettings.policy };
        if (freshSettings.accessKey && !bridgeRuntimeKey) bridgeRuntimeKey = freshSettings.accessKey;
        if (freshSettings.ctvShortLinks) bridgeState.ctvShortLinks = { ...bridgeState.ctvShortLinks, ...freshSettings.ctvShortLinks };
      }
    } catch (_settingsErr) {
      // Bỏ qua nếu không lấy được, dùng state hiện tại
    }
  }

  const policy = bridgeState.policy || {};
  const ctvField = normalizeCtvFieldServer(policy.ctvField);
  const defaultRisk = normalizeRiskTier(policy.defaultRisk) || "high";
  const atRates = policy.atRates || DEFAULT_AT_RATES;
  const ctvRates = policy.ctvRates || DEFAULT_CTV_RATES;
  const leadRisks = policy.leadRisks || {};
  const ctvRefLower = String(ctv.ref || "").trim().toLowerCase();

  let sourceLeads = Array.isArray(bridgeState.syncedLeads) ? bridgeState.syncedLeads : [];
  let loadedFromConversionsDb = false;
  const effectiveKey = bridgeState.mode === "demo" ? "" : (bridgeRuntimeKey || ENV_ACCESSTRADE_KEY || (bridgeState && bridgeState.accessKey));

  if (bridgeState.mode !== "demo") {
    // Ưu tiên đọc từ bảng public.conversions trên Supabase theo ctv_ref của đúng CTV đó
    try {
      const convResult = await getConversionsFromSupabase({ ctvRef: ctvRefLower, limit: 1000 });
      if (convResult && Array.isArray(convResult.rows) && convResult.rows.length > 0) {
        loadedFromConversionsDb = true;
        sourceLeads = convResult.rows.map(normalizeConversionRowToLead);
      }
    } catch (_convErr) {}

    if (!loadedFromConversionsDb) {
      let dbCache = null;
      try {
        dbCache = await getLeadsSnapshotFromSupabase();
      } catch (_cacheErr) {}

      let cachedLeads = null;
      let expiresAt = null;
      if (dbCache) {
        if (Array.isArray(dbCache.leads) && dbCache.leads.length > 0) {
          cachedLeads = dbCache.leads;
          expiresAt = dbCache.expires_at;
        } else if (Array.isArray(dbCache) && dbCache.length > 0) {
          cachedLeads = dbCache;
        }
      }

      const isExpired = !expiresAt || Date.now() > new Date(expiresAt).getTime();

      if (cachedLeads && cachedLeads.length > 0) {
        sourceLeads = cachedLeads;
        bridgeState.syncedLeads = cachedLeads;

        if (isExpired && effectiveKey) {
          try {
            const now = new Date();
            const start = new Date(now.getTime() - 29 * 86400000);
            const rawList = await getCachedTransactions(
              formatServerYmdGmt7(start),
              formatServerYmdGmt7(now),
              effectiveKey
            );
            const freshLeads = rawList.map(normalizeServerRawTransaction);
            if (freshLeads.length > 0) {
              sourceLeads = freshLeads;
              bridgeState.syncedLeads = freshLeads;
              saveLeadsSnapshotToSupabase(freshLeads).catch(() => {});
            }
          } catch (_fetchErr) {}
        }
      } else if (effectiveKey) {
        try {
          const now = new Date();
          const start = new Date(now.getTime() - 29 * 86400000);
          const rawList = await getCachedTransactions(
            formatServerYmdGmt7(start),
            formatServerYmdGmt7(now),
            effectiveKey
          );
          sourceLeads = rawList.map(normalizeServerRawTransaction);
          if (sourceLeads.length > 0) {
            bridgeState.syncedLeads = sourceLeads;
            saveLeadsSnapshotToSupabase(sourceLeads).catch(() => {});
          }
        } catch (_ignoreFetchErr) {}
      }
    }
  }

  const clickInfo = getClickSummaryForRef(ctv.ref);
  const orders = [];
  const totals = {
    clicks: clickInfo.total,
    clicks_today: clickInfo.today,
    total: 0,
    pending: 0,
    approved: 0,
    reconciled: 0,
    cancelled: 0,
    commission: 0
  };

  for (const lead of sourceLeads) {
    const subs = lead && lead.subs ? lead.subs : {};
    const leadRefVal = loadedFromConversionsDb
      ? String(lead.ctvRef || subs.sub2 || subs.utm_campaign || "").trim().toLowerCase()
      : String(subs[ctvField] || subs.utm_campaign || "").trim().toLowerCase();
    if (leadRefVal !== ctvRefLower) continue;

    const status = mapViewOrderStatus(lead.statusKey);
    const campUpper = String(lead.campaignName || "").toUpperCase();

    let ctvComm = 0;
    if (status !== "cancelled") {
      if (campUpper.includes("TNEX")) {
        ctvComm = Math.round((Number(lead.commission) || 0) * (2.0 / 2.5));
      } else if (campUpper.includes("VPBANK") || campUpper.includes("VP BANK")) {
        ctvComm = Math.round((Number(lead.commission) || 0) * (2.0 / 2.5));
      } else {
        const riskKey =
          normalizeRiskTier(leadRisks[lead.conversionId]) ||
          normalizeRiskTier(lead.apiRiskLevel) ||
          defaultRisk;
        const atRate = Number(atRates[riskKey]) > 0 ? Number(atRates[riskKey]) : DEFAULT_AT_RATES[riskKey];
        const ctvRate = Number(ctvRates[riskKey]) >= 0 ? Number(ctvRates[riskKey]) : DEFAULT_CTV_RATES[riskKey];
        ctvComm = Math.round((Number(lead.commission) || 0) * (ctvRate / atRate));
      }
    }

    totals.total += 1;
    totals[status] += 1;
    if (status !== "cancelled") {
      totals.commission += ctvComm;
    }

    const rawOrderId = String(lead.orderId || lead.conversionId || "").trim();
    orders.push({
      id: rawOrderId.slice(0, 6),
      campaign: String(lead.campaignName || "Sản phẩm tài chính"),
      order_value: Number.isFinite(Number(lead.orderValue)) ? Number(lead.orderValue) : 0,
      time: String(lead.timeRaw || ""),
      status
    });
  }

  const cfg = bridgeState.ctvLinkConfig || {};
  const projectName =
    (orders[0] && orders[0].campaign) ||
    (typeof cfg.projectName === "string" && cfg.projectName.trim()) ||
    "Sản phẩm tài chính AccessTrade";

  const projectLinks = {};
  const projectsMap = cfg.projects && typeof cfg.projects === "object" ? cfg.projects : {};
  const allProjectKeys = new Set(["vietcredit", "tnex", ...Object.keys(projectsMap)]);
  for (const pKey of allProjectKeys) {
    const pLink = findSalesLinkForCtv(ctv, reqOrigin, pKey);
    if (pLink) {
      projectLinks[pKey] = pLink;
    }
  }

  return {
    name: String(ctv.name || "bạn"),
    ref: String(ctv.ref || ""),
    updated_at: new Date().toISOString(),
    last_click_at: clickInfo.lastClickAt,
    totals,
    orders,
    short_link: findSalesLinkForCtv(ctv, reqOrigin) || (reqOrigin ? reqOrigin + "/l/" + encodeURIComponent(ctv.ref) : ""),
    project_links: projectLinks,
    project: {
      name: projectName,
      note: DEFAULT_PROJECT_NOTE
    },
    commission_policy: {
      low:    Number(ctvRates.low)    > 0 ? Number(ctvRates.low)    : DEFAULT_CTV_RATES.low,
      medium: Number(ctvRates.medium) > 0 ? Number(ctvRates.medium) : DEFAULT_CTV_RATES.medium,
      high:   Number(ctvRates.high)   > 0 ? Number(ctvRates.high)   : DEFAULT_CTV_RATES.high
    },
    badges: (bridgeState.policy && bridgeState.policy.ctvBadges) || null,
    extra_stats: (bridgeState.policy && bridgeState.policy.ctvExtraStats && bridgeState.policy.ctvExtraStats[ctv.ref]) || null
  };
}

const server = http.createServer(async (req, res) => {
  const reqMethod = (req.method || "GET").toUpperCase();
  const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = parsedUrl.pathname;

  if (reqMethod === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (reqMethod === "GET" && (pathname === "/" || pathname === "/index.html")) {
    serveHtmlFile(res, INDEX_HTML_PATH, "Không đọc được tệp index.html cùng thư mục.");
    return;
  }

  if (
    reqMethod === "GET" &&
    (pathname === "/ctv-view.html" ||
      pathname === "/xem" ||
      pathname === "/x" ||
      pathname.startsWith("/xem/") ||
      pathname.startsWith("/x/") ||
      /\/(?:xem|x)\/[a-z0-9]{1,64}\/?$/i.test(pathname))
  ) {
    serveHtmlFile(res, CTV_VIEW_HTML_PATH, "Không đọc được tệp ctv-view.html cùng thư mục.");
    return;
  }

  if ((reqMethod === "GET" || reqMethod === "HEAD") && pathname.startsWith("/l/")) {
    const rawPath = decodeURIComponent(pathname.slice(3)).replace(/\/+$/, "").trim();
    if (!rawPath) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><html lang='vi'><meta charset='utf-8'><title>Link không hợp lệ</title><body><h1>Link không hợp lệ</h1><p>Đường dẫn giới thiệu không đúng định dạng.</p></body></html>");
      return;
    }

    const slashIdx = rawPath.indexOf("/");
    const rawRef = (slashIdx > 0 ? rawPath.slice(0, slashIdx) : rawPath).trim();
    const reqProjectKey = (slashIdx > 0 ? rawPath.slice(slashIdx + 1).trim() : (parsedUrl.searchParams.get("p") || parsedUrl.searchParams.get("project") || "")).trim().toLowerCase();

    if (!/^[a-z0-9_]{3,40}$/i.test(rawRef)) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><html lang='vi'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Link không hợp lệ</title><body style='font-family:system-ui,sans-serif;padding:24px;max-width:480px;margin:0 auto'><h1>Link không hợp lệ</h1><p>Đường dẫn giới thiệu này không đúng định dạng hoặc đã hết hạn.</p></body></html>");
      return;
    }

    const rawRefLower = rawRef.toLowerCase();
    const existingCtv = bridgeState.ctvList.find(
      (c) => c && (
        String(c.ref || "").toLowerCase() === rawRefLower ||
        String(c.view || "").toLowerCase() === rawRefLower
      )
    );
    if (existingCtv && existingCtv.active === false) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><html lang='vi'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Link tạm ngừng</title><body style='font-family:system-ui,sans-serif;padding:24px;max-width:480px;margin:0 auto'><h1>Link bán hàng chưa sẵn sàng</h1><p>Mã cộng tác viên này đã ngừng hoạt động. Vui lòng liên hệ người quản lý.</p></body></html>");
      return;
    }

    let matchedCtv = existingCtv && existingCtv.active !== false ? existingCtv : null;

    if (!matchedCtv && bridgeState.mode !== "demo") {
      const dbCtv = await getCtvByRefFromSupabase(rawRef);
      if (dbCtv && dbCtv.active) {
        matchedCtv = dbCtv;
        bridgeState.ctvList.push(dbCtv);
      }
    }
    if (!matchedCtv && bridgeState.mode !== "demo") {
      const dbCtvByView = await getCtvByViewCodeFromSupabase(rawRef);
      if (dbCtvByView && dbCtvByView.active) {
        matchedCtv = dbCtvByView;
        bridgeState.ctvList.push(dbCtvByView);
      }
    }
    if (!matchedCtv && bridgeState.mode !== "demo") {
      // Thử nạp danh sách CTV từ app_settings trên Supabase nếu Vercel vừa khởi động lại
      const dbSettingsForCtv = await getSettingsFromSupabase();
      if (dbSettingsForCtv && Array.isArray(dbSettingsForCtv.ctvList)) {
        for (const sc of dbSettingsForCtv.ctvList) {
          if (!sc) continue;
          if (String(sc.ref || "").toLowerCase() === rawRefLower || String(sc.view || "").toLowerCase() === rawRefLower) {
            if (sc.active !== false) {
              matchedCtv = sc;
            }
          }
          const exIdx = bridgeState.ctvList.findIndex((c) => c && c.ref === sc.ref);
          if (exIdx >= 0) {
            bridgeState.ctvList[exIdx] = { ...bridgeState.ctvList[exIdx], ...sc };
          } else {
            bridgeState.ctvList.push(sc);
          }
        }
      }
    }
    if (!matchedCtv) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><html lang='vi'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Link tạm ngừng</title><body style='font-family:system-ui,sans-serif;padding:24px;max-width:480px;margin:0 auto'><h1>Link bán hàng chưa sẵn sàng</h1><p>Mã cộng tác viên này chưa được đồng bộ hoặc đã ngừng hoạt động. Vui lòng liên hệ người quản lý.</p></body></html>");
      return;
    }

    const field = normalizeCtvFieldServer(bridgeState.policy && bridgeState.policy.ctvField);
    let destUrl = buildFallbackFullSalesLink(bridgeState.ctvLinkConfig || {}, matchedCtv.ref, field, reqProjectKey);
    let destObj = null;
    try {
      destObj = destUrl ? new URL(destUrl) : null;
    } catch (_e) {
      destObj = null;
    }

    // Nếu chưa cấu hình link AccessTrade hợp lệ → load lại settings từ Supabase rồi thử lại
    if (!destObj || destObj.protocol !== "https:" || !isAllowedOutboundSalesHost(destObj.hostname)) {
      const dbSettingsForLink = await getSettingsFromSupabase();
      if (dbSettingsForLink && dbSettingsForLink.ctvLinkConfig) {
        bridgeState.ctvLinkConfig = mergeCtvLinkConfigs(bridgeState.ctvLinkConfig, dbSettingsForLink.ctvLinkConfig, false);
        if (dbSettingsForLink.policy) bridgeState.policy = { ...bridgeState.policy, ...dbSettingsForLink.policy };
        const retryUrl = buildFallbackFullSalesLink(bridgeState.ctvLinkConfig, matchedCtv.ref,
          normalizeCtvFieldServer(bridgeState.policy && bridgeState.policy.ctvField), reqProjectKey);
        try {
          const retryObj = retryUrl ? new URL(retryUrl) : null;
          if (retryObj && retryObj.protocol === "https:" && isAllowedOutboundSalesHost(retryObj.hostname)) {
            destObj = retryObj;
          }
        } catch (_e2) {}
      }
    }

    if (!destObj || destObj.protocol !== "https:" || !isAllowedOutboundSalesHost(destObj.hostname)) {
      res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><html lang='vi'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Chưa cấu hình link</title><body style='font-family:system-ui,sans-serif;padding:24px;max-width:480px;margin:0 auto'><h1>Liên kết chưa sẵn sàng</h1><p>Quản trị viên chưa cấu hình link chiến dịch AccessTrade. Vui lòng liên hệ người quản lý để được hỗ trợ.</p></body></html>");
      return;
    }

    if (isRealHumanClickRequest(req)) {
      recordRealClick(matchedCtv.ref);
    }

    res.writeHead(302, {
      Location: destObj.toString(),
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer"
    });
    res.end();
    return;
  }

  if (reqMethod === "GET" && pathname === "/api/admin/bootstrap") {
    let ctvList = bridgeState.ctvList;
    let dbSettings = null;
    try {
      const dbCtvs = await getCtvsFromSupabase();
      if (Array.isArray(dbCtvs) && dbCtvs.length > 0) {
        ctvList = dbCtvs;
        bridgeState.ctvList = dbCtvs;
      }
      const fetchedSettings = await getSettingsFromSupabase();
      if (fetchedSettings) {
        dbSettings = fetchedSettings;
        if (fetchedSettings.policy) bridgeState.policy = { ...bridgeState.policy, ...fetchedSettings.policy };
        if (fetchedSettings.ctvLinkConfig) bridgeState.ctvLinkConfig = mergeCtvLinkConfigs(bridgeState.ctvLinkConfig, fetchedSettings.ctvLinkConfig, false);
        if (fetchedSettings.ctvShortLinks) bridgeState.ctvShortLinks = { ...bridgeState.ctvShortLinks, ...fetchedSettings.ctvShortLinks };
        if (fetchedSettings.accessKey && !bridgeRuntimeKey) {
          bridgeRuntimeKey = fetchedSettings.accessKey;
        }
      }
      const dbClicks = await getClicksFromSupabase();
      if (dbClicks) {
        for (const [k, v] of Object.entries(dbClicks)) {
          if (!bridgeState.clickStats[k] || (v.total > (bridgeState.clickStats[k].total || 0))) {
            bridgeState.clickStats[k] = v;
          }
        }
      }
    } catch (_e) {}
    sendJson(res, 200, {
      ok: true,
      ctvList,
      settings: dbSettings,
      clicksByRef: buildClicksSummaryMap()
    });
    return;
  }

  if (reqMethod === "GET" && pathname === "/api/ctv-clicks") {
    if (bridgeState.mode !== "demo") {
      try {
        const dbClicks = await getClicksFromSupabase();
        if (dbClicks) {
          for (const [k, v] of Object.entries(dbClicks)) {
            if (!bridgeState.clickStats[k] || (v.total > (bridgeState.clickStats[k].total || 0))) {
              bridgeState.clickStats[k] = v;
            }
          }
        }
      } catch (_e) {}
    }
    sendJson(res, 200, {
      ok: true,
      serverTime: new Date().toISOString(),
      clicksByRef: buildClicksSummaryMap()
    });
    return;
  }

  if (reqMethod === "POST" && pathname === "/api/ctv-bridge/sync") {
    let body;
    try {
      body = await readJsonBody(req, 524288);
    } catch (readErr) {
      sendJson(res, readErr && readErr.statusCode ? readErr.statusCode : 400, {
        error: readErr && readErr.message ? readErr.message : "Dữ liệu đồng bộ không hợp lệ."
      });
      return;
    }

    const headerKeyRaw = req.headers["x-accesstrade-key"];
    if (typeof headerKeyRaw === "string" && headerKeyRaw.trim()) {
      bridgeRuntimeKey = headerKeyRaw.trim();
    } else if (body.mode === "demo") {
      bridgeRuntimeKey = "";
    }

    const cleanCtvList = [];
    if (Array.isArray(body.ctvList)) {
      for (const c of body.ctvList) {
        if (!c || typeof c !== "object") continue;
        const ref = typeof c.ref === "string" ? c.ref.trim() : "";
        const view = typeof c.view === "string" ? c.view.trim() : "";
        const name = typeof c.name === "string" ? c.name.trim().slice(0, 40) : "";
        if (!name || !/^[a-z0-9]{4,20}$/.test(ref)) continue;
        cleanCtvList.push({
          id: String(c.id || ref),
          name,
          ref,
          view: c.active !== false && /^[a-z0-9]{10,40}$/.test(view) ? view : "",
          active: c.active !== false
        });
      }
    }

    const rawCfg = body.ctvLinkConfig && typeof body.ctvLinkConfig === "object" ? body.ctvLinkConfig : {};
    const rawPolicy = body.policy && typeof body.policy === "object" ? body.policy : {};
    const rawAtRates = rawPolicy.atRates && typeof rawPolicy.atRates === "object" ? rawPolicy.atRates : {};
    const rawCtvRates = rawPolicy.ctvRates && typeof rawPolicy.ctvRates === "object" ? rawPolicy.ctvRates : {};

    const cleanLeads = [];
    if (Array.isArray(body.leads)) {
      for (const l of body.leads.slice(0, 2000)) {
        if (!l || typeof l !== "object") continue;
        const subs = l.subs && typeof l.subs === "object" ? l.subs : {};
        cleanLeads.push({
          conversionId: String(l.conversionId || ""),
          campaignName: String(l.campaignName || "Sản phẩm tài chính"),
          timeRaw: String(l.timeRaw || ""),
          commission: Number.isFinite(Number(l.commission)) ? Math.round(Number(l.commission)) : 0,
          statusKey: String(l.statusKey || "pending"),
          subs: {
            sub1: typeof subs.sub1 === "string" ? subs.sub1.trim() : "",
            sub2: typeof subs.sub2 === "string" ? subs.sub2.trim() : "",
            sub3: typeof subs.sub3 === "string" ? subs.sub3.trim() : "",
            sub4: typeof subs.sub4 === "string" ? subs.sub4.trim() : ""
          },
          apiRiskLevel: normalizeRiskTier(l.apiRiskLevel)
        });
      }
    }

    const targetMode = body.mode === "demo" ? "demo" : "real";
    const incomingProjects = sanitizeProjectsMap(rawCfg.projects);
    const hasIncomingProjects = Object.keys(incomingProjects).some((k) => hasProjectConfigData(incomingProjects[k]));
    let baseLinkCfg = bridgeState.ctvLinkConfig || {};
    const hasMemoryProjects = baseLinkCfg.projects && Object.keys(baseLinkCfg.projects).some((k) => hasProjectConfigData(baseLinkCfg.projects[k]));

    // Nếu server vừa cold-start và client chưa gửi cấu hình dự án, nạp lại từ Supabase trước khi merge để tránh ghi đè rỗng
    if (targetMode !== "demo" && !hasIncomingProjects && !hasMemoryProjects) {
      const existingDbSettings = await getSettingsFromSupabase();
      if (existingDbSettings && existingDbSettings.ctvLinkConfig) {
        baseLinkCfg = mergeCtvLinkConfigs(baseLinkCfg, existingDbSettings.ctvLinkConfig, false);
      }
    }

    const syncCfgPayload = body.ctvLinkConfig && typeof body.ctvLinkConfig === "object"
      ? { ...rawCfg, trackClicks: rawCfg.trackClicks === true }
      : rawCfg;

    bridgeState = {
      mode: targetMode,
      ctvList: cleanCtvList,
      ctvLinkConfig: mergeCtvLinkConfigs(baseLinkCfg, syncCfgPayload, true),
      ctvShortLinks:
        body.ctvShortLinks && typeof body.ctvShortLinks === "object" && !Array.isArray(body.ctvShortLinks)
          ? body.ctvShortLinks
          : {},
      clickStats: sanitizeClickStatsMap(bridgeState.clickStats),
      policy: {
        ownerName: typeof rawPolicy.ownerName === "string" && rawPolicy.ownerName.trim() ? rawPolicy.ownerName.trim() : "Dasboard Fin",
        ctvField: normalizeCtvFieldServer(rawPolicy.ctvField),
        defaultRisk: normalizeRiskTier(rawPolicy.defaultRisk) || "high",
        atRates: {
          low: Number(rawAtRates.low) > 0 ? Number(rawAtRates.low) : DEFAULT_AT_RATES.low,
          medium: Number(rawAtRates.medium) > 0 ? Number(rawAtRates.medium) : DEFAULT_AT_RATES.medium,
          high: Number(rawAtRates.high) > 0 ? Number(rawAtRates.high) : DEFAULT_AT_RATES.high
        },
        ctvRates: {
          low: Number(rawCtvRates.low) >= 0 ? Number(rawCtvRates.low) : DEFAULT_CTV_RATES.low,
          medium: Number(rawCtvRates.medium) >= 0 ? Number(rawCtvRates.medium) : DEFAULT_CTV_RATES.medium,
          high: Number(rawCtvRates.high) >= 0 ? Number(rawCtvRates.high) : DEFAULT_CTV_RATES.high
        },
        leadRisks:
          rawPolicy.leadRisks && typeof rawPolicy.leadRisks === "object" && !Array.isArray(rawPolicy.leadRisks)
            ? rawPolicy.leadRisks
            : {},
        ctvBadges:
          rawPolicy.ctvBadges && typeof rawPolicy.ctvBadges === "object" && !Array.isArray(rawPolicy.ctvBadges)
            ? rawPolicy.ctvBadges
            : (bridgeState.policy && bridgeState.policy.ctvBadges) || null,
        ctvExtraStats:
          rawPolicy.ctvExtraStats && typeof rawPolicy.ctvExtraStats === "object" && !Array.isArray(rawPolicy.ctvExtraStats)
            ? rawPolicy.ctvExtraStats
            : (bridgeState.policy && bridgeState.policy.ctvExtraStats) || {}
      },
      syncedLeads: cleanLeads,
      accessKey: bridgeRuntimeKey || (bridgeState && bridgeState.accessKey) || ""
    };
    saveBridgeStateToDisk();

    // Chỉ đồng bộ lên Supabase ở chế độ thật và chờ hoàn tất trước khi phản hồi để Vercel serverless không đóng tiến trình sớm
    if (bridgeState.mode !== "demo") {
      const supaPromises = [
        saveCtvsToSupabase(cleanCtvList, Boolean(body.replaceCtvList)),
        saveSettingsToSupabase({
          mode: bridgeState.mode,
          policy: bridgeState.policy,
          ctvLinkConfig: bridgeState.ctvLinkConfig,
          ctvShortLinks: bridgeState.ctvShortLinks,
          accessKey: bridgeState.accessKey,
          ctvList: cleanCtvList
        })
      ];
      if (cleanLeads.length > 0) {
        supaPromises.push(saveLeadsSnapshotToSupabase(cleanLeads));
      }
      await Promise.all(supaPromises).catch(() => {});
    }

    sendJson(res, 200, {
      ok: true,
      count: cleanCtvList.length,
      clicksByRef: buildClicksSummaryMap()
    });
    return;
  }

  if (reqMethod === "POST" && pathname === "/api/ctv-bridge/delete") {
    let body = {};
    try {
      body = await readJsonBody(req, 16384);
    } catch (_e) {}
    const ctvId = String(body.ctvId || body.id || "").trim();
    const ref = String(body.ref || "").trim();
    if (ctvId || ref) {
      bridgeState.ctvList = bridgeState.ctvList.filter((c) => c && c.id !== ctvId && c.ref !== ref);
      if (ref && bridgeState.clickStats) {
        delete bridgeState.clickStats[ref];
      }
      saveBridgeStateToDisk();
      if (SUPABASE_URL && SUPABASE_KEY) {
        const delTasks = [];
        if (ctvId) delTasks.push(supabaseFetch(`ctvs?id=eq.${encodeURIComponent(ctvId)}`, { method: "DELETE" }));
        if (ref) {
          delTasks.push(supabaseFetch(`ctvs?ref=eq.${encodeURIComponent(ref)}`, { method: "DELETE" }));
          delTasks.push(supabaseFetch(`ctv_clicks?ref=eq.${encodeURIComponent(ref)}`, { method: "DELETE" }));
        }
        delTasks.push(saveSettingsToSupabase({
          mode: bridgeState.mode,
          policy: bridgeState.policy,
          ctvLinkConfig: bridgeState.ctvLinkConfig,
          ctvShortLinks: bridgeState.ctvShortLinks,
          accessKey: bridgeState.accessKey,
          ctvList: bridgeState.ctvList
        }));
        await Promise.all(delTasks).catch(() => {});
      }
    }
    sendJson(res, 200, { ok: true, count: bridgeState.ctvList.length });
    return;
  }

  if (reqMethod === "GET" && pathname.startsWith("/api/view/")) {
    res.setHeader("X-CTV-Bridge", "1");
    if (!checkViewRateLimit(req)) {
      sendJson(res, 429, { error: "Bạn thao tác hơi nhanh, thử lại sau ít phút." });
      return;
    }

    const viewCode = decodeURIComponent(pathname.slice("/api/view/".length)).trim().toLowerCase();
    if (!/^[a-z0-9_]{3,64}$/i.test(viewCode)) {
      sendJson(res, 404, { error: "Link không hợp lệ." });
      return;
    }

    let matchedCtv = bridgeState.ctvList.find(
      (c) => c && c.active && (
        (c.view && c.view.toLowerCase() === viewCode) ||
        (c.ref && c.ref.toLowerCase() === viewCode)
      )
    );

    // Đồng bộ policy, cấu hình badge toggle và danh sách CTV từ Supabase (nếu có và không ở mode demo)
    if (bridgeState.mode !== "demo") {
      const dbSettings = await getSettingsFromSupabase();
      if (dbSettings) {
        if (dbSettings.policy) bridgeState.policy = { ...bridgeState.policy, ...dbSettings.policy };
        if (dbSettings.ctvLinkConfig) bridgeState.ctvLinkConfig = mergeCtvLinkConfigs(bridgeState.ctvLinkConfig, dbSettings.ctvLinkConfig, false);
        if (dbSettings.accessKey && !bridgeRuntimeKey) {
          bridgeRuntimeKey = dbSettings.accessKey;
        }
        if (Array.isArray(dbSettings.ctvList)) {
          for (const sc of dbSettings.ctvList) {
            if (!sc) continue;
            const exIdx = bridgeState.ctvList.findIndex((c) => c && c.ref === sc.ref);
            if (exIdx >= 0) {
              bridgeState.ctvList[exIdx] = { ...bridgeState.ctvList[exIdx], ...sc };
            } else {
              bridgeState.ctvList.push(sc);
            }
          }
        }
      }
    }

    // Nếu chưa tìm thấy trong RAM, kiểm tra lại sau khi đã nạp dbSettings
    if (!matchedCtv) {
      matchedCtv = bridgeState.ctvList.find(
        (c) => c && c.active !== false && (
          (c.view && c.view.toLowerCase() === viewCode) ||
          (c.ref && c.ref.toLowerCase() === viewCode)
        )
      );
    }

    // Nếu vẫn chưa thấy theo view, đọc tiếp từ bảng ctvs
    if (!matchedCtv) {
      const dbCtv = await getCtvByViewCodeFromSupabase(viewCode);
      if (dbCtv && dbCtv.active) {
        matchedCtv = dbCtv;
        const existIdx = bridgeState.ctvList.findIndex((c) => c && c.ref === dbCtv.ref);
        if (existIdx >= 0) {
          bridgeState.ctvList[existIdx] = dbCtv;
        } else {
          bridgeState.ctvList.push(dbCtv);
        }
      }
    }

    // Nếu vẫn chưa thấy theo viewCode, thử tìm theo ref từ bảng ctvs
    if (!matchedCtv) {
      const dbCtvByRef = await getCtvByRefFromSupabase(viewCode);
      if (dbCtvByRef && dbCtvByRef.active) {
        matchedCtv = dbCtvByRef;
        const existIdx = bridgeState.ctvList.findIndex((c) => c && c.ref === dbCtvByRef.ref);
        if (existIdx >= 0) {
          bridgeState.ctvList[existIdx] = dbCtvByRef;
        } else {
          bridgeState.ctvList.push(dbCtvByRef);
        }
      }
    }

    if (!matchedCtv) {
      sendJson(res, 404, { error: "Không tìm thấy hồ sơ CTV tương ứng." });
      return;
    }

    try {
      const payload = await buildCtvViewPayload(matchedCtv, resolveRequestOrigin(req));
      sendJson(res, 200, payload);
    } catch (_err) {
      sendJson(res, 502, { error: "Không tải được dữ liệu hồ sơ lúc này." });
    }
    return;
  }

  if (reqMethod === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      hasServerKey: Boolean(ENV_ACCESSTRADE_KEY)
    });
    return;
  }

  if (reqMethod === "GET" && pathname === "/api/conversions") {
    try {
      const [convResult, syncState] = await Promise.all([
        getConversionsFromSupabase({ limit: 1000 }),
        SUPABASE_SERVICE_ROLE_KEY ? getSyncStateRow().catch(() => null) : Promise.resolve(null)
      ]);
      if (!convResult) {
        sendJson(res, 200, { ok: true, available: false, totalInSupabase: 0, rows: [], syncState });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        available: true,
        totalInSupabase: convResult.totalInSupabase,
        rows: convResult.rows,
        syncState
      });
    } catch (err) {
      sendJson(res, 502, { error: err && err.message ? err.message : "Không đọc được dữ liệu Supabase conversions." });
    }
    return;
  }

  if (reqMethod === "POST" && pathname === "/api/conversions/sync") {
    const auth = verifySyncSecretAuth(req, SYNC_SECRET, ["x-sync-secret", "authorization"]);
    if (!auth.ok) {
      sendJson(res, auth.status, { error: auth.error });
      return;
    }
    let body = {};
    try {
      body = await readJsonBody(req, 16384);
    } catch (_e) {}
    const mode = body && body.mode === "backfill" ? "backfill" : "incremental";
    const weekIndex = body && body.weekIndex != null ? body.weekIndex : 0;
    const limit = body && body.limit != null ? body.limit : 200;
    try {
      const result = await runConversionsSync({ mode, source: "manual", weekIndex, limit });
      sendJson(res, 200, result);
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : 502;
      sendJson(res, status, {
        ok: false,
        stop: true,
        error: err && err.message ? err.message : "Đồng bộ thất bại."
      });
    }
    return;
  }

  if ((reqMethod === "GET" || reqMethod === "POST") && pathname === "/api/conversions/cron") {
    const auth = verifySyncSecretAuth(req, CRON_SECRET, ["authorization", "x-cron-secret"]);
    if (!auth.ok) {
      sendJson(res, auth.status, { error: auth.error });
      return;
    }
    const modeParam = parsedUrl.searchParams.get("mode") || "incremental";
    const weekParam = parsedUrl.searchParams.get("weekIndex") || "0";
    const limitParam = parsedUrl.searchParams.get("limit") || "200";
    try {
      const result = await runConversionsSync({
        mode: modeParam === "backfill" ? "backfill" : "incremental",
        source: "cron",
        weekIndex: Number(weekParam) || 0,
        limit: Number(limitParam) || 200
      });
      sendJson(res, 200, result);
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : 502;
      sendJson(res, status, {
        ok: false,
        stop: true,
        error: err && err.message ? err.message : "Đồng bộ tự động thất bại."
      });
    }
    return;
  }

  if (reqMethod === "GET" && pathname === "/api/transactions") {
    const since = parsedUrl.searchParams.get("since") || "";
    const until = parsedUrl.searchParams.get("until") || "";

    if (!isValidDateYmd(since) || !isValidDateYmd(until) || since > until) {
      sendJson(res, 400, {
        error: "Tham số ngày since và until phải đúng định dạng YYYY-MM-DD và since <= until."
      });
      return;
    }

    const headerKeyRaw = req.headers["x-accesstrade-key"];
    const headerKey = typeof headerKeyRaw === "string" ? headerKeyRaw.trim() : "";
    const effectiveKey = headerKey || ENV_ACCESSTRADE_KEY;

    if (!effectiveKey) {
      sendJson(res, 400, {
        error: "Chưa có Access Key. Vui lòng dán Access Key của bạn trong mục Cài đặt."
      });
      return;
    }

    try {
      const data = await getCachedTransactions(since, until, effectiveKey);
      if (Array.isArray(data) && data.length > 0 && bridgeState.mode !== "demo") {
        const normalized = data.map(normalizeServerRawTransaction);
        saveLeadsSnapshotToSupabase(normalized).catch(() => {});
      }
      sendJson(res, 200, { data });
    } catch (err) {
      const status = err && err.statusCode === 502 ? 502 : 502;
      const safeMessage =
        err && typeof err.message === "string"
          ? err.message
          : "Lỗi khi lấy dữ liệu từ AccessTrade.";
      console.error("[API /api/transactions] Lỗi:", safeMessage);
      sendJson(res, status, { error: safeMessage });
    }
    return;
  }

  if (reqMethod === "POST" && pathname === "/api/create-link") {
    let body;
    try {
      body = await readJsonBody(req, 16384);
    } catch (readErr) {
      sendJson(res, readErr && readErr.statusCode ? readErr.statusCode : 400, {
        error: readErr && readErr.message ? readErr.message : "Dữ liệu không hợp lệ."
      });
      return;
    }

    const campaignId = typeof body.campaign_id === "string" ? body.campaign_id.trim() : "";
    const targetUrl = typeof body.target_url === "string" ? body.target_url.trim() : "";

    if (!/^\d{4,30}$/.test(campaignId)) {
      sendJson(res, 400, {
        error: "Mã chiến dịch (campaign_id) phải là dãy số hợp lệ từ AccessTrade."
      });
      return;
    }

    if (targetUrl) {
      try {
        const parsedTarget = new URL(targetUrl);
        if (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") {
          throw new Error("invalid protocol");
        }
      } catch (_urlErr) {
        sendJson(res, 400, {
          error: "Link đích (target_url) phải bắt đầu bằng http:// hoặc https://."
        });
        return;
      }
    }

    const headerKeyRaw = req.headers["x-accesstrade-key"];
    const headerKey = typeof headerKeyRaw === "string" ? headerKeyRaw.trim() : "";
    const effectiveKey = headerKey || ENV_ACCESSTRADE_KEY;

    if (!effectiveKey) {
      sendJson(res, 400, {
        error: "Chưa có Access Key. Vui lòng dán Access Key của bạn trong mục Cài đặt."
      });
      return;
    }

    try {
      const result = await createAccessTradeTrackingLink({
        campaignId,
        targetUrl,
        accessKey: effectiveKey
      });
      sendJson(res, 200, result);
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : 502;
      const safeMessage =
        err && typeof err.message === "string"
          ? err.message
          : "Lỗi khi gọi API tạo link AccessTrade.";
      console.error("[API /api/create-link] Lỗi:", safeMessage);
      sendJson(res, status, { error: safeMessage });
    }
    return;
  }

  if (reqMethod === "POST" && pathname === "/api/resolve-short-link") {
    let body;
    try {
      body = await readJsonBody(req, 8192);
    } catch (readErr) {
      sendJson(res, readErr && readErr.statusCode ? readErr.statusCode : 400, {
        error: readErr && readErr.message ? readErr.message : "Dữ liệu không hợp lệ."
      });
      return;
    }

    const shortUrl = typeof body.url === "string" ? body.url.trim() : "";
    if (!shortUrl) {
      sendJson(res, 400, { error: "Vui lòng gửi kèm link rút gọn cần giải mã." });
      return;
    }

    try {
      const resolved = await resolveAccessTradeShortLink(shortUrl, resolveRequestOrigin(req));
      sendJson(res, 200, resolved);
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : 502;
      const safeMessage =
        err && typeof err.message === "string"
          ? err.message
          : "Không thể giải mã link rút gọn.";
      console.error("[API /api/resolve-short-link] Lỗi:", safeMessage);
      sendJson(res, status, { error: safeMessage });
    }
    return;
  }

  if (reqMethod === "POST" && pathname === "/api/shorten-link") {
    let body;
    try {
      body = await readJsonBody(req, 16384);
    } catch (readErr) {
      sendJson(res, readErr && readErr.statusCode ? readErr.statusCode : 400, {
        error: readErr && readErr.message ? readErr.message : "Dữ liệu không hợp lệ."
      });
      return;
    }

    const fullUrl = typeof body.full_url === "string" ? body.full_url.trim() : "";
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "auto";
    const campaignId = typeof body.campaign_id === "string" ? body.campaign_id.trim() : "";
    const targetUrl = typeof body.target_url === "string" ? body.target_url.trim() : "";
    const rawSubField = typeof body.sub_field === "string" ? body.sub_field.trim().toLowerCase() : "sub2";
    const subField =
      rawSubField === "sub1" || rawSubField === "sub2" || rawSubField === "sub3" || rawSubField === "sub4"
        ? rawSubField
        : "sub2";
    const subValue = typeof body.sub_value === "string" ? body.sub_value.trim() : "";
    const projectKey = typeof body.project_key === "string" ? body.project_key.trim().toLowerCase() : "";

    if (!fullUrl) {
      sendJson(res, 400, { error: "Thiếu link bán hàng đầy đủ (full_url) để rút gọn." });
      return;
    }

    const headerKeyRaw = req.headers["x-accesstrade-key"];
    const headerKey = typeof headerKeyRaw === "string" ? headerKeyRaw.trim() : "";
    const effectiveKey = headerKey || ENV_ACCESSTRADE_KEY;

    try {
      const shortened = await createShortTrackingLink({
        fullUrl,
        provider,
        campaignId,
        targetUrl,
        subField,
        subValue,
        projectKey,
        accessKey: effectiveKey
      });
      sendJson(res, 200, shortened);
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : 502;
      const safeMessage =
        err && typeof err.message === "string"
          ? err.message
          : "Không thể tạo link rút gọn cho CTV.";
      console.error("[API /api/shorten-link] Lỗi:", safeMessage);
      sendJson(res, status, { error: safeMessage });
    }
    return;
  }

  sendJson(res, 404, { error: "Không tìm thấy đường dẫn yêu cầu." });
});

if (!process.env.VERCEL) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log("Dasboard Fin đang chạy tại http://localhost:" + PORT);
  });
}

module.exports = server;
