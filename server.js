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

const ENV_ACCESSTRADE_KEY = (process.env.ACCESSTRADE_KEY || "").trim();
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
const BRIDGE_STATE_PATH = path.join(__dirname, ".ctv-bridge-state.json");
const cache = new Map();
const inFlight = new Map();
const viewRateMap = new Map();

const DEFAULT_AT_RATES = { low: 2.45, medium: 1.93, high: 1.58 };
const DEFAULT_CTV_RATES = { low: 1.8, medium: 1.28, high: 1.0 };
const DEFAULT_PROJECT_NOTE =
  "Đối soát và thanh toán vào ngày 18 và 25 hằng tháng, mốc có thể khác theo chiến dịch";

let bridgeRuntimeKey = "";
let bridgeState = {
  mode: "demo",
  ctvList: [],
  ctvLinkConfig: {
    publisher: "",
    campaign: "",
    targetUrl: "",
    baseSalesLink: "",
    viewBase: "",
    salesLinkMode: "short_auto",
    trackClicks: true
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
          trackClicks: parsedCfg.trackClicks !== false
        },
        ctvShortLinks:
          parsed.ctvShortLinks && typeof parsed.ctvShortLinks === "object"
            ? parsed.ctvShortLinks
            : {},
        clickStats: sanitizeClickStatsMap(parsed.clickStats),
        syncedLeads: Array.isArray(parsed.syncedLeads) ? parsed.syncedLeads : []
      };
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
      syncedLeads: bridgeState.syncedLeads
    };
    fs.writeFileSync(BRIDGE_STATE_PATH, JSON.stringify(safeCopy), "utf8");
  } catch (_err) {
    // Bỏ qua nếu hệ thống file chỉ đọc
  }
}

loadBridgeStateFromDisk();

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-AccessTrade-Key");
  res.setHeader("Access-Control-Expose-Headers", "X-CTV-Bridge");
  if (ALLOWED_ORIGIN !== "*") {
    res.setHeader("Vary", "Origin");
  }
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

async function shortenViaIsGd(fullUrl) {
  const endpoint = ISGD_API_BASE + "/create.php?format=json&url=" + encodeURIComponent(fullUrl);
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
    throw err;
  }

  let data = null;
  try {
    data = await response.json();
  } catch (_e) {
    data = null;
  }

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
  const m = String(urlObj.pathname || "").match(/^\/l\/([a-z0-9]{4,20})\/?$/i);
  return m ? m[1] : "";
}

async function createShortTrackingLink({
  fullUrl,
  provider,
  campaignId,
  targetUrl,
  subField,
  subValue,
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
    const isgdRes = await shortenViaIsGd(fullUrlObj.toString());
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

  // Chế độ "auto": nếu là link /l/<mã> thì giữ nguyên tầng đếm lượt nhấp bằng cách rút gọn qua is.gd -> TinyURL; nếu là link AccessTrade trực tiếp thì ưu tiên shorten.asia nếu có key
  if (isAtTracking && accessKey && /^\d{4,30}$/.test(campaignId)) {
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
    const isgdAuto = await shortenViaIsGd(fullUrlObj.toString());
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
    /(facebookexternalhit|facebot|zalopc|zalo\/|telegrambot|slackbot|whatsapp|discordbot|googlebot|bingbot|twitterbot|linkedinbot|applebot|bot\b|crawler|spider|preview)/i.test(
      ua
    )
  ) {
    return false;
  }
  return true;
}

function recordRealClick(ref) {
  if (!/^[a-z0-9]{4,20}$/i.test(String(ref || ""))) return null;
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
    if (/^[a-z0-9]{4,20}$/i.test(ref)) {
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

function buildFallbackFullSalesLink(cfg, ref, ctvField) {
  const field = normalizeCtvFieldServer(ctvField);
  if (cfg.baseSalesLink) {
    try {
      const u = new URL(cfg.baseSalesLink);
      if (field !== "sub2") {
        u.searchParams.delete("sub2");
      }
      u.searchParams.set(field, ref);
      return u.toString();
    } catch (_e) {
      return "";
    }
  }
  if (/^\d{4,30}$/.test(cfg.publisher || "") && /^\d{4,30}$/.test(cfg.campaign || "") && cfg.targetUrl) {
    try {
      const targetCheck = new URL(cfg.targetUrl);
      if (targetCheck.protocol === "https:" || targetCheck.protocol === "http:") {
        return (
          "https://go.isclix.com/deep_link/" +
          encodeURIComponent(cfg.publisher) +
          "/" +
          encodeURIComponent(cfg.campaign) +
          "?url=" +
          encodeURIComponent(cfg.targetUrl) +
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

function findSalesLinkForCtv(ctv, reqOrigin) {
  const cfg = bridgeState.ctvLinkConfig || {};
  const field = normalizeCtvFieldServer(bridgeState.policy && bridgeState.policy.ctvField);
  const fullUrl = buildFallbackFullSalesLink(cfg, ctv.ref, field);
  if (!fullUrl || !fullUrl.startsWith("https://")) return "";

  const mode = typeof cfg.salesLinkMode === "string" && cfg.salesLinkMode ? cfg.salesLinkMode : "short_auto";
  const cacheMap = bridgeState.ctvShortLinks || {};

  if (cfg.trackClicks === true && mode !== "short_accesstrade") {
    const trackedBase = getTrackedBaseUrl(cfg, reqOrigin);
    const trackedUrl = trackedBase ? trackedBase + "/l/" + encodeURIComponent(ctv.ref) : "";
    if (trackedUrl && isAllowedClientSalesUrl(trackedUrl)) {
      if (mode !== "full") {
        const trackedCacheEntry = cacheMap[mode + "|" + trackedUrl];
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

  const exactEntry = cacheMap[mode + "|" + fullUrl];
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

async function buildCtvViewPayload(ctv, reqOrigin) {
  const policy = bridgeState.policy || {};
  const ctvField = normalizeCtvFieldServer(policy.ctvField);
  const defaultRisk = normalizeRiskTier(policy.defaultRisk) || "high";
  const atRates = policy.atRates || DEFAULT_AT_RATES;
  const ctvRates = policy.ctvRates || DEFAULT_CTV_RATES;
  const leadRisks = policy.leadRisks || {};

  let sourceLeads = Array.isArray(bridgeState.syncedLeads) ? bridgeState.syncedLeads : [];
  const effectiveKey = bridgeRuntimeKey || ENV_ACCESSTRADE_KEY;

  if (bridgeState.mode === "real" && effectiveKey) {
    try {
      const now = new Date();
      const start = new Date(now.getTime() - 29 * 86400000);
      const rawList = await getCachedTransactions(
        formatServerYmdGmt7(start),
        formatServerYmdGmt7(now),
        effectiveKey
      );
      sourceLeads = rawList.map(normalizeServerRawTransaction);
    } catch (_ignoreFetchErr) {
      // Nếu gọi upstream lỗi tạm thời thì fallback về snapshot đã đồng bộ gần nhất
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
    if (String(subs[ctvField] || "").trim() !== ctv.ref) continue;

    const status = mapViewOrderStatus(lead.statusKey);
    const riskKey =
      normalizeRiskTier(leadRisks[lead.conversionId]) ||
      normalizeRiskTier(lead.apiRiskLevel) ||
      defaultRisk;
    const atRate = Number(atRates[riskKey]) > 0 ? Number(atRates[riskKey]) : DEFAULT_AT_RATES[riskKey];
    const ctvRate = Number(ctvRates[riskKey]) >= 0 ? Number(ctvRates[riskKey]) : DEFAULT_CTV_RATES[riskKey];

    const ctvComm =
      status === "cancelled"
        ? 0
        : Math.round((Number(lead.commission) || 0) * (ctvRate / atRate));

    totals.total += 1;
    totals[status] += 1;
    if (status !== "cancelled") {
      totals.commission += ctvComm;
    }

    orders.push({
      id: String(lead.conversionId || ""),
      campaign: String(lead.campaignName || "Sản phẩm tài chính"),
      time: String(lead.timeRaw || ""),
      status,
      commission: ctvComm
    });
  }

  const cfg = bridgeState.ctvLinkConfig || {};
  const projectName =
    (orders[0] && orders[0].campaign) ||
    (typeof cfg.projectName === "string" && cfg.projectName.trim()) ||
    "Sản phẩm tài chính AccessTrade";

  return {
    name: String(ctv.name || "bạn"),
    updated_at: new Date().toISOString(),
    last_click_at: clickInfo.lastClickAt,
    totals,
    orders,
    short_link: findSalesLinkForCtv(ctv, reqOrigin),
    project: {
      name: projectName,
      note: DEFAULT_PROJECT_NOTE
    }
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
      pathname.startsWith("/xem/") ||
      /\/xem\/[a-z0-9]{1,64}\/?$/i.test(pathname))
  ) {
    serveHtmlFile(res, CTV_VIEW_HTML_PATH, "Không đọc được tệp ctv-view.html cùng thư mục.");
    return;
  }

  if ((reqMethod === "GET" || reqMethod === "HEAD") && pathname.startsWith("/l/")) {
    const rawRef = decodeURIComponent(pathname.slice(3)).replace(/\/+$/, "").trim();
    if (!/^[a-z0-9]{4,20}$/i.test(rawRef)) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><html lang='vi'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Link không hợp lệ</title><body style='font-family:system-ui,sans-serif;padding:24px;max-width:480px;margin:0 auto'><h1>Link không hợp lệ</h1><p>Đường dẫn giới thiệu này không đúng định dạng hoặc đã hết hạn.</p></body></html>");
      return;
    }

    const matchedCtv = bridgeState.ctvList.find(
      (c) => c && c.active !== false && String(c.ref || "").toLowerCase() === rawRef.toLowerCase()
    );
    if (!matchedCtv) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><html lang='vi'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Link tạm ngừng</title><body style='font-family:system-ui,sans-serif;padding:24px;max-width:480px;margin:0 auto'><h1>Link bán hàng chưa sẵn sàng</h1><p>Mã cộng tác viên này chưa được đồng bộ hoặc đã ngừng hoạt động. Vui lòng liên hệ người quản lý.</p></body></html>");
      return;
    }

    const field = normalizeCtvFieldServer(bridgeState.policy && bridgeState.policy.ctvField);
    const destUrl = buildFallbackFullSalesLink(bridgeState.ctvLinkConfig || {}, matchedCtv.ref, field);
    let destObj = null;
    try {
      destObj = destUrl ? new URL(destUrl) : null;
    } catch (_e) {
      destObj = null;
    }

    if (!destObj || destObj.protocol !== "https:" || !isAccessTradeTrackingHost(destObj.hostname)) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><html lang='vi'><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Chưa cấu hình link</title><body style='font-family:system-ui,sans-serif;padding:24px;max-width:480px;margin:0 auto'><h1>Chưa có link sản phẩm</h1><p>Quản trị viên chưa lưu cấu hình link AccessTrade hợp lệ cho chiến dịch này.</p></body></html>");
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

  if (reqMethod === "GET" && pathname === "/api/ctv-clicks") {
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

    bridgeState = {
      mode: body.mode === "real" ? "real" : "demo",
      ctvList: cleanCtvList,
      ctvLinkConfig: {
        publisher: typeof rawCfg.publisher === "string" ? rawCfg.publisher.trim() : "",
        campaign: typeof rawCfg.campaign === "string" ? rawCfg.campaign.trim() : "",
        targetUrl: typeof rawCfg.targetUrl === "string" ? rawCfg.targetUrl.trim() : "",
        baseSalesLink: typeof rawCfg.baseSalesLink === "string" ? rawCfg.baseSalesLink.trim() : "",
        viewBase: typeof rawCfg.viewBase === "string" ? rawCfg.viewBase.trim().replace(/\/+$/, "") : "",
        salesLinkMode: typeof rawCfg.salesLinkMode === "string" ? rawCfg.salesLinkMode.trim() : "short_auto",
        trackClicks: rawCfg.trackClicks === true
      },
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
            : {}
      },
      syncedLeads: cleanLeads
    };
    saveBridgeStateToDisk();
    sendJson(res, 200, {
      ok: true,
      count: cleanCtvList.length,
      clicksByRef: buildClicksSummaryMap()
    });
    return;
  }

  if (reqMethod === "GET" && pathname.startsWith("/api/view/")) {
    res.setHeader("X-CTV-Bridge", "1");
    if (!checkViewRateLimit(req)) {
      sendJson(res, 429, { error: "Bạn thao tác hơi nhanh, thử lại sau ít phút." });
      return;
    }

    const viewCode = decodeURIComponent(pathname.slice("/api/view/".length)).trim();
    if (!/^[a-z0-9]{10,40}$/.test(viewCode)) {
      sendJson(res, 404, { error: "Link không hợp lệ." });
      return;
    }

    const matchedCtv = bridgeState.ctvList.find(
      (c) => c && c.active && c.view && c.view === viewCode
    );
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

server.listen(PORT, "0.0.0.0", () => {
  console.log("Dasboard Fin đang chạy tại http://localhost:" + PORT);
});
