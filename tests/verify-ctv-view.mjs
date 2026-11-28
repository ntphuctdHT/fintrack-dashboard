import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT_DIR = process.cwd();
const CTV_VIEW_HTML = fs.readFileSync(path.join(ROOT_DIR, "ctv-view.html"), "utf8");

function loadCtvViewApi() {
  const scriptMatch = CTV_VIEW_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "Expected inline <script> in ctv-view.html");

  let exported = null;
  const noopEl = () => ({
    textContent: "",
    innerHTML: "",
    hidden: false,
    href: "",
    value: "",
    style: {},
    setAttribute() {},
    getAttribute() {
      return "";
    },
    addEventListener() {},
    appendChild() {},
    focus() {},
    select() {},
    setSelectionRange() {}
  });

  const context = vm.createContext({
    __CTV_VIEW_TEST_HOOK__: (api) => {
      exported = api;
    },
    window: {
      location: {
        protocol: "https:",
        pathname: "/",
        search: "",
        hash: "",
        href: "https://viewer.example.vn/"
      },
      history: { replaceState() {} },
      setTimeout,
      clearTimeout,
      setInterval: () => 0,
      fetch: async () => {
        throw new Error("unexpected fetch in unit context");
      }
    },
    document: {
      visibilityState: "visible",
      getElementById: noopEl,
      querySelectorAll: () => [],
      createElement: noopEl
    },
    navigator: {},
    Intl,
    Date,
    Number,
    String,
    Array,
    Math,
    URL,
    URLSearchParams,
    JSON,
    encodeURIComponent,
    decodeURIComponent
  });

  vm.runInContext(scriptMatch[1], context);
  assert.ok(exported, "Expected __CTV_VIEW_TEST_HOOK__ to export helper functions");
  return exported;
}

test("ctv-view.html complies strictly with isolation, privacy, accessibility, and zero-external-asset rules", () => {
  // Privacy & SEO meta tags
  assert.match(CTV_VIEW_HTML, /<meta\s+name="robots"\s+content="noindex,\s*nofollow"\s*\/>/i);
  assert.match(CTV_VIEW_HTML, /<meta\s+name="referrer"\s+content="no-referrer"\s*\/>/i);
  assert.match(CTV_VIEW_HTML, /viewport-fit=cover/);
  assert.match(CTV_VIEW_HTML, /env\(safe-area-inset-top\)/);
  assert.match(CTV_VIEW_HTML, /env\(safe-area-inset-bottom\)/);
  assert.match(CTV_VIEW_HTML, /prefers-color-scheme:\s*dark/);

  // Zero external scripts, stylesheets, fonts, images, shadows, gradients, storage, cookies, or console logs
  assert.doesNotMatch(CTV_VIEW_HTML, /<script[^>]+src=/i);
  assert.doesNotMatch(CTV_VIEW_HTML, /<link[^>]+rel=["']stylesheet["']/i);
  assert.doesNotMatch(CTV_VIEW_HTML, /fonts\.googleapis|fonts\.gstatic/i);
  assert.doesNotMatch(CTV_VIEW_HTML, /box-shadow\s*:/i);
  assert.doesNotMatch(CTV_VIEW_HTML, /linear-gradient|radial-gradient/i);
  assert.doesNotMatch(CTV_VIEW_HTML, /localStorage|sessionStorage/i);
  assert.doesNotMatch(CTV_VIEW_HTML, /document\.cookie/i);
  assert.doesNotMatch(CTV_VIEW_HTML, /console\.(log|info|warn|error|debug)/i);
  assert.doesNotMatch(CTV_VIEW_HTML, /style=/i);

  // Zero leaked owner commission formulas, Access Keys, or forbidden words
  assert.doesNotMatch(CTV_VIEW_HTML, /Access\s*Key|X-AccessTrade-Key/i);
  assert.doesNotMatch(CTV_VIEW_HTML, /\b(1\.58|1,58|2\.45|2,45|1\.93|1,93)\b/);
  assert.doesNotMatch(CTV_VIEW_HTML, /thực tế/i);

  // Required accessibility & UX attributes/copy
  assert.equal((CTV_VIEW_HTML.match(/<h1\b/gi) || []).length, 1);
  assert.match(CTV_VIEW_HTML, /role="status"/);
  assert.match(CTV_VIEW_HTML, /aria-pressed="true"/);
  assert.match(CTV_VIEW_HTML, /rel="noopener noreferrer"/);
  assert.match(CTV_VIEW_HTML, /const API_BASE = "";/);
  assert.match(CTV_VIEW_HTML, /AUTO_REFRESH_MS\s*=\s*15000/);
});

test("ctv-view.html pure logic handles view codes, GMT+7, VND, status, XSS safety, and demo data", () => {
  const api = loadCtvViewApi();

  // 1. View code extraction priority: /xem/<code> > ?c=<code> > #<code>, lowercase a-z0-9, length 10..40
  const fromPath = api.readViewLocation({
    pathname: "/xem/abcd123456ef",
    search: "?c=zzzzzzzzzz",
    hash: "#yyyyyyyyyy"
  });
  assert.equal(fromPath.source, "path");
  assert.equal(fromPath.isValid, true);
  assert.equal(fromPath.code, "abcd123456ef");

  const fromQuery = api.readViewLocation({
    pathname: "/",
    search: "?c=mnopqrstuv123456",
    hash: "#yyyyyyyyyy"
  });
  assert.equal(fromQuery.source, "query");
  assert.equal(fromQuery.isValid, true);
  assert.equal(fromQuery.code, "mnopqrstuv123456");

  const fromHash = api.readViewLocation({
    pathname: "/index.html",
    search: "",
    hash: "#hashcode987654321"
  });
  assert.equal(fromHash.source, "hash");
  assert.equal(fromHash.isValid, true);
  assert.equal(fromHash.code, "hashcode987654321");

  // Boundary lengths & invalid chars
  assert.equal(api.readViewLocation({ pathname: "/xem/123456789", search: "", hash: "" }).isValid, false);
  assert.equal(api.readViewLocation({ pathname: "/xem/1234567890", search: "", hash: "" }).isValid, true);
  assert.equal(
    api.readViewLocation({ pathname: "/xem/" + "a".repeat(40), search: "", hash: "" }).isValid,
    true
  );
  assert.equal(
    api.readViewLocation({ pathname: "/xem/" + "a".repeat(41), search: "", hash: "" }).isValid,
    false
  );
  assert.equal(api.readViewLocation({ pathname: "/xem/ABCD123456", search: "", hash: "" }).isValid, false);
  assert.equal(api.readViewLocation({ pathname: "/", search: "?c=bad_code!12", hash: "" }).isValid, false);

  // 2. Time parsing (GMT+7 default when no offset) & formatting
  const dtNoTz = api.parseVietnamTime("2026-11-20 23:30:00");
  assert.equal(dtNoTz.toISOString(), "2026-11-20T16:30:00.000Z");
  assert.equal(api.formatVietnamDayMonth(dtNoTz), "20/11");

  const dtUtc = api.parseVietnamTime("2026-11-20T18:05:00Z");
  assert.equal(api.formatVietnamDayMonth(dtUtc), "21/11");
  assert.match(api.formatVietnamClockTime(dtUtc), /01:05/);

  // 3. Currency & URL check & status meta
  assert.equal(api.formatVnd(1250000), "1.250.000đ");
  assert.equal(api.formatVnd(-500), "0đ");
  assert.equal(api.isHttpsUrl("https://shorten.asia/abc"), true);
  assert.equal(api.isHttpsUrl("http://shorten.asia/abc"), false);
  assert.equal(api.isHttpsUrl("javascript:alert(1)"), false);
  assert.equal(api.resolveStatusMeta("pending").label, "⏳ Chờ duyệt");
  assert.equal(api.resolveStatusMeta("approved").label, "✔ Đã duyệt");
  assert.equal(api.resolveStatusMeta("reconciled").label, "✔✔ Đã đối soát");
  assert.equal(api.resolveStatusMeta("cancelled").label, "✖ Đã huỷ");

  // 4. Bridge normalization: sorts newest first, enforces 0 on cancelled, strips non-https link, supplies default note
  const normalized = api.normalizeBridgePayload({
    name: '<script>alert(1)</script>',
    updated_at: "2026-11-22T10:30:00+07:00",
    orders: [
      { id: "101", campaign: "Old", time: "2026-11-18T10:00:00+07:00", status: "approved", commission: 200000 },
      { id: "102", campaign: "Cancelled", time: "2026-11-21T10:00:00+07:00", status: "cancelled", commission: 999999 },
      { id: "103", campaign: "Newest", time: "2026-11-22T09:00:00+07:00", status: "pending", commission: 150000 }
    ],
    short_link: "http://insecure.example/a",
    project: { name: "Tin Vay" }
  });
  assert.equal(normalized.orders.map((o) => o.id).join(","), "103,102,101");
  assert.equal(normalized.orders[1].commission, 0);
  assert.equal(normalized.totals.clicks, 0);
  assert.equal(normalized.totals.clicksToday, 0);
  assert.equal(normalized.totals.total, 3);
  assert.equal(normalized.totals.commission, 350000);
  assert.equal(normalized.shortLink, "");
  assert.match(normalized.project.note, /18 và 25 hằng tháng/);
  assert.equal(
    api.escapeHtml(normalized.name),
    "&lt;script&gt;alert(1)&lt;/script&gt;"
  );

  // 4b. Explicit click counts, local HTTP tracked link support, and preservation of smart-masked order IDs
  const withClicks = api.normalizeBridgePayload({
    name: "Minh",
    totals: { clicks: 15, clicks_today: 4 },
    orders: [
      { id: "ng*****hieu034*******", campaign: "tnex_vay", time: "2026-11-26T10:00:00+07:00", status: "pending" },
      { id: "494045787", campaign: "vcredit2026", time: "2026-11-26T09:00:00+07:00", status: "approved" }
    ],
    short_link: "http://localhost:3000/l/ab23cd45"
  });
  assert.equal(withClicks.totals.clicks, 15);
  assert.equal(withClicks.totals.clicksToday, 4);
  assert.equal(withClicks.orders[0].id, "ng*****hieu034*******", "Smart-masked TNEX order ID (21+ chars) must NOT be truncated");
  assert.equal(withClicks.orders[1].id, "494045", "Numeric order ID remains sliced to 6 chars");
  assert.equal(withClicks.shortLink, "http://localhost:3000/l/ab23cd45");

  // 5. Demo payload covers 8 items and all 4 statuses totaling 1.250.000đ
  const demo = api.buildDemoData();
  assert.equal(demo.orders.length, 8);
  assert.equal(demo.totals.clicks, 42);
  assert.equal(demo.totals.clicksToday, 6);
  assert.equal(demo.totals.total, 8);
  assert.equal(demo.totals.pending, 2);
  assert.equal(demo.totals.approved, 3);
  assert.equal(demo.totals.reconciled, 2);
  assert.equal(demo.totals.cancelled, 1);
  assert.equal(demo.totals.commission, 1250000);
  assert.equal(api.isHttpsUrl(demo.shortLink), true);
});

