import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { spawn } from "node:child_process";

const ROOT_DIR = process.cwd();
const INDEX_HTML = fs.readFileSync(path.join(ROOT_DIR, "index.html"), "utf8");
const CTV_VIEW_HTML_SRC = fs.readFileSync(path.join(ROOT_DIR, "ctv-view.html"), "utf8");
const SERVER_JS = fs.readFileSync(path.join(ROOT_DIR, "server.js"), "utf8");

test("index.html meets structural, security, and no-external-library constraints", () => {
  assert.match(INDEX_HTML, /viewport-fit=cover/);
  assert.match(INDEX_HTML, /env\(safe-area-inset-top\)/);
  assert.match(INDEX_HTML, /env\(safe-area-inset-bottom\)/);
  assert.match(INDEX_HTML, /data-theme/);
  assert.match(INDEX_HTML, /prefers-color-scheme:\s*dark/);
  assert.match(INDEX_HTML, /inputmode="url"/);
  assert.match(INDEX_HTML, /id="input-access-key"/);
  assert.match(INDEX_HTML, /id="btn-toggle-key"/);
  assert.match(INDEX_HTML, /X-AccessTrade-Key/);
  assert.match(INDEX_HTML, /aria-current="page"/);
  assert.match(INDEX_HTML, /aria-pressed/);
  assert.match(INDEX_HTML, /Dasboard Fin/);
  assert.match(INDEX_HTML, /Minh bạch - Rõ ràng/);
  assert.match(INDEX_HTML, /Đối soát vào ngày 18 và 25 hằng tháng \(T\+1\), mốc có thể khác theo chiến dịch\./);
  assert.match(INDEX_HTML, /Chưa có hồ sơ ở trạng thái này\./);

  // Không dùng thư viện ngoài
  assert.doesNotMatch(INDEX_HTML, /<script[^>]+src=/i);
  assert.doesNotMatch(INDEX_HTML, /<link[^>]+rel=["']stylesheet["']/i);
  // Không chứa biến môi trường hay khoá cứng
  assert.doesNotMatch(INDEX_HTML, /ACCESSTRADE_KEY/);
  // Không dùng Math.random()
  assert.doesNotMatch(INDEX_HTML, /Math\.random/);
  // Có đủ 4 tab và thông báo trạng thái rỗng CTV
  assert.match(INDEX_HTML, /id="tab-ctv"/);
  assert.match(INDEX_HTML, /Chưa có CTV nào\. Nhập biệt danh ở trên rồi bấm Tạo mã CTV\./);

  // Chống lỗi ReferenceError (btn / listContainer chưa khai báo) trong trình xử lý click CTV
  const clickBlockMatch = INDEX_HTML.match(
    /var ctvListContainer = document\.getElementById\("ctv-list-container"\);[\s\S]*?var downloadBackupBtn/
  );
  assert.ok(clickBlockMatch, "Expected ctvListContainer click handler block");
  assert.doesNotMatch(clickBlockMatch[0], /(^|[^\w.])btn\.(getAttribute|disabled|textContent)/m);
  assert.doesNotMatch(clickBlockMatch[0], /(^|[^\w.])listContainer\./m);
  assert.match(INDEX_HTML, /function flashCopyButton[\s\S]*?querySelectorAll/);
});

test("CTV project copy buttons (VietCredit & TNEX) shorten, copy to clipboard, flash button, and show toast without ReferenceError", async () => {
  const scriptMatch = INDEX_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "Expected inline <script> in index.html");
  let scriptBody = scriptMatch[1];

  scriptBody = scriptBody.replace(
    "applyBranding();",
    `globalThis.__CLICK_TEST_EXPORTS__ = { state, bindEvents, renderCtvListOnly };
    return;`
  );

  const elements = new Map();
  const makeEl = (id) => {
    const listeners = {};
    const el = {
      id,
      textContent: "",
      innerHTML: "",
      hidden: true,
      className: "",
      value: "",
      style: {},
      attributes: {},
      classList: {
        add(c) { el.className += " " + c; },
        remove(c) { el.className = el.className.replace(c, "").trim(); },
        contains(c) { return el.className.split(/\s+/).includes(c); }
      },
      setAttribute(k, v) { el.attributes[k] = String(v); },
      getAttribute(k) { return el.attributes[k] || ""; },
      appendChild() {},
      removeChild() {},
      focus() {},
      select() {},
      setSelectionRange() {},
      addEventListener(ev, fn) {
        if (!listeners[ev]) listeners[ev] = [];
        listeners[ev].push(fn);
      },
      async trigger(ev, evObj) {
        const list = listeners[ev] || [];
        for (const fn of list) {
          await fn(evObj);
        }
      },
      querySelectorAll() { return []; },
      querySelector() { return null; }
    };
    return el;
  };

  const ctvListContainer = makeEl("ctv-list-container");
  const appToast = makeEl("app-toast");
  elements.set("ctv-list-container", ctvListContainer);
  elements.set("app-toast", appToast);

  const makeMockBtn = (attrs, label) => {
    const b = makeEl("");
    b.attributes = { ...attrs };
    b.textContent = label;
    b.isConnected = true;
    return b;
  };
  const vcBtn = makeMockBtn({ "data-ctv-action": "copy-project-sales", "data-project-key": "vietcredit", "data-ctv-id": "ctv1" }, "📋 Copy link VietCredit");
  const tnexBtn = makeMockBtn({ "data-ctv-action": "copy-project-sales", "data-project-key": "tnex", "data-ctv-id": "ctv1" }, "📋 Copy link TNEX (MSB)");
  const viewShortBtn = makeMockBtn({ "data-ctv-action": "copy-view-short", "data-ctv-id": "ctv1" }, "Copy link dạng rút gọn");

  ctvListContainer.querySelectorAll = (sel) => {
    if (sel.includes('data-project-key="vietcredit"')) return [vcBtn];
    if (sel.includes('data-project-key="tnex"')) return [tnexBtn];
    if (sel.includes('data-ctv-action="copy-view-short"')) return [viewShortBtn];
    return [];
  };

  const copiedItems = [];
  const shortenRequests = [];
  const mockStore = {};
  const mockWindow = {
    location: { protocol: "https:", origin: "https://dash.example.vn" },
    crypto: globalThis.crypto,
    setTimeout: (fn, ms) => { if (ms < 500) fn(); return 1; },
    clearTimeout: () => {},
    localStorage: {
      getItem: (k) => mockStore[k] || null,
      setItem: (k, v) => { mockStore[k] = String(v); }
    },
    fetch: async (url, opts) => {
      if (String(url).includes("/api/shorten-link")) {
        const body = JSON.parse(opts.body);
        shortenRequests.push(body);
        const shortUrl =
          body.project_key === "dashboard"
            ? "https://is.gd/Dashboard_mock77"
            : body.project_key === "tnex"
              ? "https://is.gd/Tnex_mock99"
              : "https://is.gd/VietCredit_mock88";
        return {
          ok: true,
          status: 200,
          json: async () => ({ short_url: shortUrl, provider: "isgd", provider_label: "is.gd" })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  };

  const context = vm.createContext({
    window: mockWindow,
    navigator: {
      clipboard: {
        writeText: async (text) => { copiedItems.push(text); }
      }
    },
    document: {
      visibilityState: "visible",
      documentElement: { setAttribute() {}, removeAttribute() {} },
      addEventListener: () => {},
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, makeEl(id));
        return elements.get(id);
      },
      querySelectorAll: () => [],
      createElement: () => makeEl("")
    },
    crypto: globalThis.crypto,
    Uint8Array,
    Intl,
    Date,
    Number,
    String,
    Array,
    Math,
    URL,
    JSON
  });

  vm.runInContext(scriptBody, context);
  const { state, bindEvents } = context.__CLICK_TEST_EXPORTS__;
  state.ctvList = [{ id: "ctv1", name: "Minh", ref: "minh88", view: "viewcode1234567890123456", active: true }];
  state.expandedCtvId = "ctv1";
  state.ctvLinkConfig = {
    publisher: "4876420781540702864",
    campaign: "6997817930567730686",
    targetUrl: "https://tinvay.vietcredit.com.vn/",
    viewBase: "https://dash.example.vn",
    salesLinkMode: "short_auto",
    trackClicks: true,
    defaultProject: "vietcredit",
    projects: {
      vietcredit: {
        id: "vietcredit",
        publisher: "4876420781540702864",
        campaign: "6997817930567730686",
        targetUrl: "https://tinvay.vietcredit.com.vn/"
      },
      tnex: {
        id: "tnex",
        publisher: "4876420781540702864",
        campaign: "7777666655554444333",
        targetUrl: "https://tnex.com.vn/"
      }
    }
  };
  bindEvents();

  // Click VietCredit copy button
  await ctvListContainer.trigger("click", {
    target: { closest: (sel) => (sel === "[data-ctv-action]" ? vcBtn : null) }
  });
  assert.equal(shortenRequests[0].project_key, "vietcredit");
  assert.equal(copiedItems[0], "https://is.gd/VietCredit_mock88");
  assert.equal(appToast.hidden, false);
  assert.match(appToast.textContent, /https:\/\/is\.gd\/VietCredit_mock88/);
  assert.match(vcBtn.className, /btn-copied-flash/);
  assert.equal(vcBtn.textContent, "✅ Đã sao chép!");

  // Click TNEX copy button
  await ctvListContainer.trigger("click", {
    target: { closest: (sel) => (sel === "[data-ctv-action]" ? tnexBtn : null) }
  });
  assert.equal(shortenRequests[1].project_key, "tnex");
  assert.equal(copiedItems[1], "https://is.gd/Tnex_mock99");
  assert.match(appToast.textContent, /https:\/\/is\.gd\/Tnex_mock99/);
  assert.match(tnexBtn.className, /btn-copied-flash/);
  assert.equal(tnexBtn.textContent, "✅ Đã sao chép!");

  // Click Dashboard short view copy button
  await ctvListContainer.trigger("click", {
    target: { closest: (sel) => (sel === "[data-ctv-action]" ? viewShortBtn : null) }
  });
  assert.equal(shortenRequests[2].project_key, "dashboard");
  assert.equal(copiedItems[2], "https://is.gd/Dashboard_mock77");
  assert.match(appToast.textContent, /https:\/\/is\.gd\/Dashboard_mock77/);
  assert.match(viewShortBtn.className, /btn-copied-flash/);
  assert.equal(viewShortBtn.textContent, "✅ Đã sao chép!");
});

test("index.html pure logic functions work accurately (XSS, GMT+7, status, stats)", () => {
  const scriptMatch = INDEX_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "Expected inline <script> in index.html");
  let scriptBody = scriptMatch[1];

  scriptBody = scriptBody.replace(
    "applyBranding();",
    `globalThis.__TEST_EXPORTS__ = {
      escapeHtml,
      getInitials,
      isValidHttpUrl,
      parseVietnamTime,
      toVietnamDateKey,
      formatVnd,
      resolveLeadStatus,
      normalizeRiskLevel,
      normalizeCtvField,
      parseRateNumber,
      getLeadCtvCode,
      resolveLeadProjectKey,
      getFilteredLeads,
      computeLeadSplit,
      computeClickOverviewStats,
      normalizeLead,
      normalizeAndSortLeads,
      computeStats,
      collectCtvGroups,
      buildCtvExportHtml,
      validateExportHtmlSafe,
      computeLast7Days,
      buildDemoLeads,
      loadSavedSettings,
      generateRandomToken,
      createCtvRecord,
      findCtvByRef,
      countLeadsForCtv,
      hasCompleteCtvLinkConfig,
      isNumericAccessTradeId,
      isAccessTradeAccountCode,
      isShortenerHost,
      decodeBase64UrlSafe,
      parseAccessTradeLink,
      validateCtvLinkConfig,
      normalizeSalesLinkMode,
      isShortSalesLinkMode,
      salesLinkModeToProvider,
      buildCtvSalesLink,
      buildCtvTrackedBridgeLink,
      getOutboundTrackingBaseLink,
      buildShortLinkCacheKey,
      getCachedCtvShortEntry,
      getEffectiveCtvSalesLink,
      buildCtvViewLink,
      buildCtvInviteMessage,
      sanitizeViewBaseUrl,
      validateViewBaseUrl,
      getEffectiveViewBaseUrl,
      rotateCtvViewCode,
      retireCtv,
      reactivateCtv,
      serializeCtvBackup,
      parseAndValidateCtvBackup,
      state
    };
    return;`
  );

  const mockStore = {
    dasboard_fin_ctv_policy_v2: JSON.stringify({
      ownerName: "Team Fin",
      ctvField: "sub3",
      defaultRisk: "medium",
      atRates: { low: 2.5, medium: 2.0, high: 1.6 },
      ctvRates: { low: 1.85, medium: 1.3, high: 1.0 }
    }),
    dasboard_fin_lead_risks_v2: JSON.stringify({ "DEMO-016": "low" })
  };
  const mockWindow = {
    location: { protocol: "file:", origin: "null" },
    crypto: globalThis.crypto,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(mockStore, k) ? mockStore[k] : null),
      setItem: () => { }
    }
  };
  const context = vm.createContext({
    window: mockWindow,
    document: {
      documentElement: { setAttribute() { }, removeAttribute() { } },
      getElementById: () => ({ textContent: "", innerHTML: "", hidden: false, style: {} }),
      querySelectorAll: () => []
    },
    crypto: globalThis.crypto,
    Uint8Array,
    Intl,
    Date,
    Number,
    String,
    Array,
    Math,
    URL,
    JSON
  });

  vm.runInContext(scriptBody, context);
  const api = context.__TEST_EXPORTS__;

  api.loadSavedSettings();
  assert.equal(api.state.ownerName, "Team Fin");
  assert.equal(api.state.ctvField, "sub3");
  assert.equal(api.state.defaultRisk, "medium");
  assert.equal(api.state.atRates.high, 1.6);
  assert.equal(api.state.ctvRates.low, 1.85);
  assert.equal(api.state.leadRisks["DEMO-016"], "low");

  assert.equal(
    api.escapeHtml('<img src=x onerror="alert(1)"> & \'test\''),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;test&#39;"
  );
  assert.equal(api.getInitials("Dasboard Fin"), "DF");
  assert.equal(api.isValidHttpUrl("https://api.example.com"), true);
  assert.equal(api.isValidHttpUrl("http://localhost:3000"), true);
  assert.equal(api.isValidHttpUrl("javascript:alert(1)"), false);

  const noTz = api.parseVietnamTime("2026-11-20 23:30:00");
  assert.equal(api.toVietnamDateKey(noTz), "2026-11-20");
  assert.equal(noTz.toISOString(), "2026-11-20T16:30:00.000Z");

  const withUtc = api.parseVietnamTime("2026-11-20T18:00:00Z");
  assert.equal(api.toVietnamDateKey(withUtc), "2026-11-21");

  assert.equal(api.resolveLeadStatus(2, 1).fullLabel, "✖ Đã huỷ");
  assert.equal(api.resolveLeadStatus(1, 1).fullLabel, "✔✔ Đã đối soát");
  assert.equal(api.resolveLeadStatus(1, 0).fullLabel, "✔ Đã duyệt");
  assert.equal(api.resolveLeadStatus(0, 0).fullLabel, "⏳ Chờ duyệt");

  assert.equal(api.resolveLeadProjectKey("vcredit2026"), "vietcredit");
  assert.equal(api.resolveLeadProjectKey("Tin Vay VietCredit"), "vietcredit");
  assert.equal(api.resolveLeadProjectKey("tinvay"), "vietcredit");
  assert.equal(api.resolveLeadProjectKey("tnex_vay"), "tnex");
  api.state.leads = api.normalizeAndSortLeads([
    { conversion_id: "101", advertiser: "vcredit2026", sales_time: "2026-11-27T09:00:00+07:00", status: 0, commission: 300000 },
    { conversion_id: "102", advertiser: "tnex_vay", sales_time: "2026-11-27T09:10:00+07:00", status: 1, commission: 120000 }
  ]);
  api.state.filterStatus = "all";
  api.state.filterProject = "vietcredit";
  assert.equal(api.getFilteredLeads().length, 1);
  assert.equal(api.getFilteredLeads()[0].conversionId, "101");
  api.state.filterProject = "tnex";
  assert.equal(api.getFilteredLeads().length, 1);
  assert.equal(api.getFilteredLeads()[0].conversionId, "102");
  api.state.filterProject = "all";
  api.state.leads = [];

  assert.equal(api.normalizeRiskLevel("Low"), "low");
  assert.equal(api.normalizeRiskLevel("MEDIUM"), "medium");
  assert.equal(api.normalizeRiskLevel("high"), "high");
  assert.equal(api.normalizeRiskLevel("unknown"), "");
  assert.equal(api.normalizeCtvField("SUB2"), "sub2");
  assert.equal(api.normalizeCtvField("invalid"), "sub2");
  assert.equal(api.parseRateNumber("1,58"), 1.58);
  assert.equal(api.parseRateNumber("2.45%"), 2.45);

  const normalized = api.normalizeAndSortLeads([
    { id: "ID-1", campaign_name: "Vay A", click_time: "2026-11-18 09:00:00", commission: 500000, status: 1, is_confirmed: 0, sub2: "CTV-A" },
    { conversion_id: "CV-2", merchant: "Thẻ B", transaction_time: "2026-11-20 10:00:00", commission: 490000, status: 1, is_confirmed: 1, sub2: "CTV-A", risk_level: "low" },
    { conversion_id: "CV-3", campaign_id: 99, sales_time: "2026-11-19 12:00:00", commission: 600000, status: 2, is_confirmed: 0, sub2: "CTV-B" }
  ]);
  assert.equal(normalized[0].conversionId, "CV-2");
  assert.equal(normalized[1].campaignName, "Chiến dịch #99");
  assert.equal(api.getLeadCtvCode(normalized[0], "sub2"), "CTV-A");

  const defaultPolicy = {
    atRates: { low: 2.45, medium: 1.93, high: 1.58 },
    ctvRates: { low: 1.8, medium: 1.28, high: 1.0 },
    defaultRisk: "high",
    leadRisks: {}
  };

  // CV-2 has API risk_level='low': 490,000 * (1.80 / 2.45) = 360,000; owner = 130,000
  const splitCv2 = api.computeLeadSplit(normalized[0], defaultPolicy);
  assert.equal(splitCv2.riskKey, "low");
  assert.equal(splitCv2.ctvCommission, 360000);
  assert.equal(splitCv2.ownerShare, 130000);

  // ID-1 unassigned defaults to High: 500,000 * (1.00 / 1.58) = 316,456; owner = 183,544
  const splitId1Default = api.computeLeadSplit(normalized[2], defaultPolicy);
  assert.equal(splitId1Default.riskKey, "high");
  assert.equal(splitId1Default.ctvCommission, 316456);
  assert.equal(splitId1Default.ownerShare, 183544);

  // Manual override to Medium on ID-1: 500,000 * (1.28 / 1.93) = 331,606; owner = 168,394
  const splitId1Manual = api.computeLeadSplit(normalized[2], {
    ...defaultPolicy,
    leadRisks: { "ID-1": "medium" }
  });
  assert.equal(splitId1Manual.riskKey, "medium");
  assert.equal(splitId1Manual.ctvCommission, 331606);
  assert.equal(splitId1Manual.ownerShare, 168394);

  // Cancelled lead CV-3 always has CTV commission 0 and owner share 0
  const splitCv3Cancelled = api.computeLeadSplit(normalized[1], defaultPolicy);
  assert.equal(splitCv3Cancelled.ctvCommission, 0);
  assert.equal(splitCv3Cancelled.ownerShare, 0);

  // Stats exclude cancelled CV-3
  const stats = api.computeStats(normalized, defaultPolicy);
  assert.equal(stats.commission, 990000);
  assert.equal(stats.ctvCommission, 360000 + 316456);
  assert.equal(stats.ownerShare, 130000 + 183544);
  assert.equal(stats.ctvCommission + stats.ownerShare, stats.commission);

  // Grouping & static export safety checks
  const groups = api.collectCtvGroups(normalized, "sub2");
  assert.deepEqual(Array.from(groups.codes), ["CTV-A", "CTV-B"]);

  const exportRows = [
    {
      campaignName: "Thẻ B",
      conversionId: "CV-2",
      displayTime: "10:00 20/11/2026",
      statusKey: "confirmed",
      statusLabel: "✔✔ Đã đối soát",
      statusCssClass: "status-confirmed",
      ctvCommission: 360000,
      realCommission: 490000,
      ownerShare: 130000
    }
  ];
  const exportedHtml = api.buildCtvExportHtml({
    ctvCode: "CTV-A",
    ownerName: "Chủ Shop Fin",
    exportedAtText: "20:00 22/11/2026",
    rows: exportRows
  });

  assert.match(exportedHtml, /Mức hoa hồng CTV:.*theo thoả thuận với Chủ Shop Fin/);
  assert.match(exportedHtml, /Chưa gồm VAT/);
  assert.match(exportedHtml, /Dữ liệu tại thời điểm:.*20:00 22\/11\/2026/);
  assert.doesNotMatch(exportedHtml, /fetch\(/);
  assert.doesNotMatch(exportedHtml, /XMLHttpRequest/);

  const checkCtx = {
    accessKey: "secret-at-key-123",
    atRates: defaultPolicy.atRates,
    ctvRows: exportRows,
    allowedNumbers: { "360000": true },
    otherLeadIds: ["CV-3"],
    ctvStats: { realCommission: 490000, ownerShare: 130000 },
    allLeadsStats: stats
  };
  assert.equal(api.validateExportHtmlSafe(exportedHtml, checkCtx).ok, true);
  assert.equal(api.validateExportHtmlSafe(exportedHtml + " 1,58", checkCtx).ok, false);
  assert.equal(api.validateExportHtmlSafe(exportedHtml + " 1.58", checkCtx).ok, false);
  assert.equal(api.validateExportHtmlSafe(exportedHtml + " 490.000đ", checkCtx).ok, false);
  assert.equal(api.validateExportHtmlSafe(exportedHtml + " secret-at-key-123", checkCtx).ok, false);
  assert.equal(api.validateExportHtmlSafe(exportedHtml + ' "CV-3"', checkCtx).ok, false);

  const demo = api.buildDemoLeads();
  assert.equal(demo.length, 16);
  const sevenDays = api.computeLast7Days(demo);
  assert.equal(sevenDays.length, 7);

  // Tự kiểm tra CTV: tạo 100 CTV, kiểm tra độ dài, bộ ký tự, không trùng, link, đổi mã xem, cho nghỉ, sao lưu & khôi phục
  const charsetRegex = /^[abcdefghjkmnpqrstuvwxyz23456789]+$/;
  const generatedCtvs = [];
  const seenRefs = new Set();
  const seenViews = new Set();
  for (let i = 0; i < 100; i += 1) {
    const rec = api.createCtvRecord("CTV Số " + (i + 1), generatedCtvs);
    assert.equal(rec.ref.length, 8);
    assert.equal(rec.view.length, 24);
    assert.match(rec.ref, charsetRegex);
    assert.match(rec.view, charsetRegex);
    assert.equal(rec.active, true);
    assert.equal(seenRefs.has(rec.ref), false);
    assert.equal(seenViews.has(rec.view), false);
    assert.equal(seenRefs.has(rec.view), false);
    assert.equal(seenViews.has(rec.ref), false);
    seenRefs.add(rec.ref);
    seenViews.add(rec.view);
    generatedCtvs.push(rec);
  }
  assert.equal(generatedCtvs.length, 100);

  const firstCtv = generatedCtvs[0];
  const incompleteCfg = {
    publisher: "4608706208340350795",
    campaign: "6997817930567730686",
    targetUrl: "",
    viewBase: "https://x.vn"
  };
  assert.equal(api.hasCompleteCtvLinkConfig(incompleteCfg), false);

  // Reject AT-account username (like AT72050) which causes go.isclix.com 404
  const atCodeCfg = {
    publisher: "AT72050",
    campaign: "6997817930567730686",
    targetUrl: "https://tinvay.vietcredit.com.vn/",
    viewBase: "https://myview.vn"
  };
  const atCodeCheck = api.validateCtvLinkConfig(atCodeCfg);
  assert.equal(atCodeCheck.ok, false);
  assert.equal(atCodeCheck.field, "publisher");
  assert.match(atCodeCheck.reason, /AT72050/);
  assert.match(atCodeCheck.reason, /404/);
  assert.equal(api.hasCompleteCtvLinkConfig(atCodeCfg), false);

  // parseAccessTradeLink handles valid 2-segment deep links, v2, single-segment, direct adv.php, and broken links
  const parsedPair = api.parseAccessTradeLink(
    "https://go.isclix.com/deep_link/4608706208340350795/6997817930567730686?url=https%3A%2F%2Ftinvay.vietcredit.com.vn%2F&sub2=oldref"
  );
  assert.equal(parsedPair.ok, true);
  assert.equal(parsedPair.mode, "deep_link_pair");
  assert.equal(parsedPair.publisher, "4608706208340350795");
  assert.equal(parsedPair.campaign, "6997817930567730686");
  assert.equal(parsedPair.targetUrl, "https://tinvay.vietcredit.com.vn/");
  assert.equal(parsedPair.baseSalesLink, "");

  const parsedBroken = api.parseAccessTradeLink(
    "https://go.isclix.com/deep_link/AT72050/6997817930567730686?url=https%3A%2F%2Ftinvay.vietcredit.com.vn%2F&sub2=ghjctmnd"
  );
  assert.equal(parsedBroken.ok, false);
  assert.match(parsedBroken.error, /404/);

  const parsedShort = api.parseAccessTradeLink("https://shorten.asia/47RUQaAe");
  assert.equal(parsedShort.ok, false);
  assert.equal(parsedShort.isShortener, true);
  assert.equal(parsedShort.canAutoResolve, true);

  // Decode Base64 url_enc & parse /deep_link/v6/{publisher_id}/{campaign_id}
  assert.equal(
    api.decodeBase64UrlSafe("aHR0cHM6Ly90aW52YXkudmlldGNyZWRpdC5jb20udm4v"),
    "https://tinvay.vietcredit.com.vn/"
  );
  const parsedV6 = api.parseAccessTradeLink(
    "https://go.isclix.com/deep_link/v6/4876420781540702864/6997817930567730686?sub4=oneatweb&url_enc=aHR0cHM6Ly90aW52YXkudmlldGNyZWRpdC5jb20udm4v"
  );
  assert.equal(parsedV6.ok, true);
  assert.equal(parsedV6.mode, "deep_link_v6_pair");
  assert.equal(parsedV6.publisher, "4876420781540702864");
  assert.equal(parsedV6.campaign, "6997817930567730686");
  assert.equal(parsedV6.targetUrl, "https://tinvay.vietcredit.com.vn/");
  assert.match(parsedV6.baseSalesLink, /deep_link\/v6\/4876420781540702864\/6997817930567730686/);

  // Reject raw shortener URL inside baseSalesLink (it drops sub2!)
  const rawShortBaseCheck = api.validateCtvLinkConfig({
    publisher: "",
    campaign: "",
    targetUrl: "",
    viewBase: "https://myview.vn",
    baseSalesLink: "https://shorten.asia/47RUQaAe"
  });
  assert.equal(rawShortBaseCheck.ok, false);
  assert.equal(rawShortBaseCheck.field, "baseSalesLink");

  // Build CTV link from resolved v6 baseSalesLink preserves sub4 & url_enc and sets sub2
  const v6Cfg = {
    publisher: parsedV6.publisher,
    campaign: parsedV6.campaign,
    targetUrl: parsedV6.targetUrl,
    viewBase: "https://myview.vn",
    baseSalesLink: parsedV6.baseSalesLink
  };
  assert.equal(api.hasCompleteCtvLinkConfig(v6Cfg), true);
  const builtV6 = new URL(api.buildCtvSalesLink(v6Cfg, firstCtv.ref));
  assert.equal(builtV6.pathname, "/deep_link/v6/4876420781540702864/6997817930567730686");
  assert.equal(builtV6.searchParams.get("sub4"), "oneatweb");
  assert.equal(builtV6.searchParams.get("url_enc"), "aHR0cHM6Ly90aW52YXkudmlldGNyZWRpdC5jb20udm4v");
  assert.equal(builtV6.searchParams.get("sub2"), firstCtv.ref);

  const parsedDirect = api.parseAccessTradeLink(
    "https://click.accesstrade.vn/adv.php?rk=0005u6000x2t&sub2=stale&url=https%3A%2F%2Ftinvay.vietcredit.com.vn%2F"
  );
  assert.equal(parsedDirect.ok, true);
  assert.equal(parsedDirect.mode, "direct_aff_link");
  assert.equal(parsedDirect.baseSalesLink.includes("sub2=stale"), false);

  const linkCfg = {
    publisher: "4608706208340350795",
    campaign: "6997817930567730686",
    targetUrl: "https://bank.vn/the?utm=1&ref=a",
    viewBase: "https://myview.vn///",
    baseSalesLink: ""
  };
  assert.equal(api.hasCompleteCtvLinkConfig(linkCfg), true);
  assert.equal(
    api.buildCtvSalesLink(linkCfg, firstCtv.ref),
    "https://go.isclix.com/deep_link/4608706208340350795/6997817930567730686?url=https%3A%2F%2Fbank.vn%2Fthe%3Futm%3D1%26ref%3Da&sub2=" +
    firstCtv.ref
  );

  // Direct baseSalesLink preserves rk= and replaces sub2 cleanly
  const directCfg = {
    publisher: "",
    campaign: "",
    targetUrl: "",
    viewBase: "https://myview.vn",
    baseSalesLink: parsedDirect.baseSalesLink
  };
  assert.equal(api.hasCompleteCtvLinkConfig(directCfg), true);
  const builtDirect = new URL(api.buildCtvSalesLink(directCfg, firstCtv.ref));
  assert.equal(builtDirect.searchParams.get("rk"), "0005u6000x2t");
  assert.equal(builtDirect.searchParams.get("sub2"), firstCtv.ref);

  assert.equal(
    api.buildCtvViewLink(linkCfg, firstCtv.view),
    "https://myview.vn/xem/" + firstCtv.view
  );

  // Reject AccessTrade tracking URLs, shorteners, placeholder domains, query strings, and targetUrl match in viewBase
  assert.equal(
    api.validateViewBaseUrl(
      "https://go.isclix.com/deep_link/v6/4876420781540702864/6997817930567730686?sub4=oneatweb&utm_campaign=thu001&url_enc=aHR0cHM6Ly90aW52YXkudmlldGNyZWRpdC5jb20udm4v",
      "https://tinvay.vietcredit.com.vn/"
    ).ok,
    false
  );
  assert.equal(api.validateViewBaseUrl("https://shorten.asia/47RUQaAe").ok, false);
  assert.equal(api.validateViewBaseUrl("https://ten-mien-cua-ban.com").ok, false);
  assert.equal(api.validateViewBaseUrl("https://myview.vn/?foo=bar").ok, false);
  assert.equal(
    api.validateViewBaseUrl("https://tinvay.vietcredit.com.vn/", "https://tinvay.vietcredit.com.vn/").ok,
    false
  );
  assert.equal(api.validateCtvLinkConfig({
    ...v6Cfg,
    viewBase: "https://go.isclix.com/deep_link/v6/4876420781540702864/6997817930567730686?sub4=oneatweb&url_enc=aHR0cHM6Ly90aW52YXkudmlldGNyZWRpdC5jb20udm4v"
  }).field, "viewBase");
  assert.equal(
    api.buildCtvViewLink({ viewBase: "https://myview.vn/ctv-view.html" }, firstCtv.view),
    "https://myview.vn/xem/" + firstCtv.view
  );

  const msg = api.buildCtvInviteMessage(firstCtv, linkCfg);
  assert.match(msg, new RegExp("Chào " + firstCtv.name));
  assert.match(msg, /https:\/\/go\.isclix\.com\/deep_link\/4608706208340350795\/6997817930567730686/);
  assert.match(msg, new RegExp("https://myview\\.vn/xem/" + firstCtv.view));

  // Sales link mode normalization & short link caching + invalidation
  assert.equal(api.normalizeSalesLinkMode(""), "short_auto");
  assert.equal(api.normalizeSalesLinkMode("full"), "full");
  assert.equal(api.normalizeSalesLinkMode("short_isgd"), "short_isgd");
  assert.equal(api.isShortSalesLinkMode("short_auto"), true);
  assert.equal(api.isShortSalesLinkMode("full"), false);
  assert.equal(api.salesLinkModeToProvider("short_isgd"), "isgd");
  assert.equal(api.salesLinkModeToProvider("short_accesstrade"), "accesstrade");
  assert.equal(api.salesLinkModeToProvider("short_auto"), "auto");

  const shortCfg = { ...v6Cfg, salesLinkMode: "short_auto" };
  const fullV6 = api.buildCtvSalesLink(shortCfg, firstCtv.ref, "sub2");
  const shortCacheKey = api.buildShortLinkCacheKey(shortCfg.salesLinkMode, fullV6);
  const shortCacheMap = {
    [shortCacheKey]: {
      shortUrl: "https://is.gd/mockctv1",
      provider: "isgd",
      providerLabel: "is.gd"
    }
  };
  assert.equal(
    api.getEffectiveCtvSalesLink(shortCfg, firstCtv.ref, shortCacheMap, "sub2"),
    "https://is.gd/mockctv1"
  );
  // Switching to full mode bypasses short link cache immediately
  assert.equal(
    api.getEffectiveCtvSalesLink({ ...shortCfg, salesLinkMode: "full" }, firstCtv.ref, shortCacheMap, "sub2"),
    fullV6
  );
  // Changing campaign invalidates cache cleanly
  assert.equal(
    api.getEffectiveCtvSalesLink(
      { ...shortCfg, baseSalesLink: "", campaign: "9999888877776666" },
      firstCtv.ref,
      shortCacheMap,
      "sub2"
    ).includes("9999888877776666"),
    true
  );
  // Invite message embeds the shortened link when cached in short mode
  const shortMsg = api.buildCtvInviteMessage(firstCtv, shortCfg, shortCacheMap, "sub2");
  assert.match(shortMsg, /https:\/\/is\.gd\/mockctv1/);

  // Real click tracking helpers & outbound tracked link resolution
  const clickOverview = api.computeClickOverviewStats(
    { a: { total: 10, today: 3 }, b: { total: 15, today: 2 } },
    5
  );
  assert.equal(clickOverview.total, 25);
  assert.equal(clickOverview.today, 5);
  assert.equal(clickOverview.convRate, "20,0%");
  const zeroOverview = api.computeClickOverviewStats({}, 4);
  assert.equal(zeroOverview.total, 0);
  assert.equal(zeroOverview.today, 0);
  assert.equal(zeroOverview.convRate, "—");

  assert.equal(
    api.buildCtvTrackedBridgeLink({ viewBase: "https://myview.vn///" }, firstCtv.ref),
    "https://myview.vn/l/" + firstCtv.ref
  );
  assert.equal(
    api.getOutboundTrackingBaseLink({ ...v6Cfg, trackClicks: true }, firstCtv.ref, "sub2"),
    "https://myview.vn/l/" + firstCtv.ref
  );
  assert.equal(
    api
      .getOutboundTrackingBaseLink(
        { ...v6Cfg, trackClicks: true, salesLinkMode: "short_accesstrade" },
        firstCtv.ref,
        "sub2"
      )
      .startsWith("https://go.isclix.com/"),
    true
  );
  const trackedShortCfg = { ...v6Cfg, trackClicks: true, salesLinkMode: "short_auto" };
  const trackedUrl = api.buildCtvTrackedBridgeLink(trackedShortCfg, firstCtv.ref);
  const trackedCacheMap = {
    [api.buildShortLinkCacheKey("short_auto", trackedUrl)]: {
      shortUrl: "https://is.gd/tracked1",
      provider: "isgd",
      providerLabel: "is.gd"
    }
  };
  assert.equal(
    api.getEffectiveCtvSalesLink(trackedShortCfg, firstCtv.ref, trackedCacheMap, "sub2"),
    "https://is.gd/tracked1"
  );

  // _extra.sub2 preservation and matching
  const extraLeads = api.normalizeAndSortLeads([
    {
      conversion_id: "EXT-1",
      merchant: "VPBank",
      transaction_time: "2026-11-21 10:00:00",
      commission: 500000,
      status: 1,
      _extra: { sub2: firstCtv.ref }
    }
  ]);
  assert.equal(extraLeads[0].subs.sub2, firstCtv.ref);
  assert.equal(api.findCtvByRef(extraLeads[0].subs.sub2, generatedCtvs).name, firstCtv.name);
  assert.equal(api.countLeadsForCtv(firstCtv.ref, extraLeads), 1);

  // Rotate view code -> new 24-char code, old code no longer matches
  const oldView = firstCtv.view;
  const rotated = api.rotateCtvViewCode(generatedCtvs, firstCtv.id);
  assert.notEqual(rotated.updated.view, oldView);
  assert.equal(rotated.updated.view.length, 24);
  assert.equal(rotated.updated.ref, firstCtv.ref);

  // Retire -> clears view, keeps ref, active false; reactivate -> active true + new view
  const retired = api.retireCtv(rotated.list, firstCtv.id);
  assert.equal(retired.updated.active, false);
  assert.equal(retired.updated.view, "");
  assert.equal(retired.updated.ref, firstCtv.ref);
  const reactivated = api.reactivateCtv(retired.list, firstCtv.id);
  assert.equal(reactivated.updated.active, true);
  assert.equal(reactivated.updated.view.length, 24);
  assert.equal(reactivated.updated.ref, firstCtv.ref);

  // Backup & strict restore validation
  const backupJson = api.serializeCtvBackup(generatedCtvs);
  const restored = api.parseAndValidateCtvBackup(backupJson);
  assert.equal(restored.ok, true);
  assert.equal(restored.list.length, 100);
  assert.equal(restored.list[0].ref, generatedCtvs[0].ref);
  assert.equal(restored.list[99].view, generatedCtvs[99].view);
  assert.equal(api.parseAndValidateCtvBackup("not-json").ok, false);
  assert.equal(
    api.parseAndValidateCtvBackup(
      JSON.stringify([{ id: "1", name: "Bad", ref: "CTV-001", view: "abc23456", active: true, created: "2026-01-01" }])
    ).ok,
    false
  );
});

test("server.js runs standalone without ACCESSTRADE_KEY env, accepts X-AccessTrade-Key header, isolates cache per key, and never leaks keys", async () => {
  const HEADER_KEY_A = "client-key-alpha-secret";
  const HEADER_KEY_B = "client-key-beta-secret";
  let upstreamCalls = 0;
  let upstreamStatus = 200;
  let capturedAuth = "";
  let capturedContentType = "";

  let lastCreateLinkPayload = null;
  let mockIsGdShouldFail = false;

  const mockAtServer = http.createServer((req, res) => {
    upstreamCalls += 1;
    capturedAuth = req.headers["authorization"] || "";
    capturedContentType = req.headers["content-type"] || "";

    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/v1/product_link/create") {
      let rawBody = "";
      req.on("data", (chunk) => {
        rawBody += chunk.toString();
      });
      req.on("end", () => {
        const parsed = JSON.parse(rawBody || "{}");
        lastCreateLinkPayload = parsed;
        const subSuffix = parsed.sub2 ? "&sub2=" + encodeURIComponent(parsed.sub2) : "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              error_link: [],
              suspend_url: [],
              success_link: [
                {
                  aff_link:
                    "https://go.isclix.com/deep_link/4608706208340350795/" +
                    parsed.campaign_id +
                    "?url=" +
                    encodeURIComponent((parsed.urls && parsed.urls[0]) || "https://tinvay.vietcredit.com.vn/") +
                    subSuffix,
                  short_link: parsed.sub2 ? "https://shorten.asia/atMock99" : "https://rutgon.me/mock",
                  url_origin: (parsed.urls && parsed.urls[0]) || "https://tinvay.vietcredit.com.vn/"
                }
              ]
            }
          })
        );
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/create.php") {
      if (mockIsGdShouldFail) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ errorcode: 4, errormessage: "Rate limited" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ shorturl: "https://is.gd/mock123" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api-create.php") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("https://tinyurl.com/mock456");
      return;
    }

    if (req.method === "GET" && url.pathname === "/47RUQaAe") {
      res.writeHead(302, {
        Location:
          "https://go.isclix.com/deep_link/v6/4876420781540702864/6997817930567730686?sub4=oneatweb&url_enc=aHR0cHM6Ly90aW52YXkudmlldGNyZWRpdC5jb20udm4v"
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/mock123") {
      res.writeHead(301, {
        Location:
          "https://go.isclix.com/deep_link/v6/4876420781540702864/6997817930567730686?sub4=oneatweb&url_enc=aHR0cHM6Ly90aW52YXkudmlldGNyZWRpdC5jb20udm4v&sub2=ab23cd45"
      });
      res.end();
      return;
    }

    const page = Number(url.searchParams.get("page") || "1");

    if (upstreamStatus !== 200) {
      res.writeHead(upstreamStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }

    const items = [];
    const count = page === 1 ? 100 : page === 2 ? 25 : 0;
    for (let i = 0; i < count; i++) {
      items.push({
        conversion_id: `AT-P${page}-${i + 1}`,
        merchant: capturedAuth.includes("alpha") ? "Thẻ Alpha" : "Thẻ Beta",
        transaction_time: "2026-11-20 10:00:00",
        commission: 100000,
        status: 1,
        is_confirmed: page === 2 ? 1 : 0,
        sub1: "test_sub"
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: items }));
  });

  await new Promise((resolve) => mockAtServer.listen(0, "127.0.0.1", resolve));
  const mockPort = mockAtServer.address().port;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "df-proxy-direct-"));
  fs.writeFileSync(path.join(tmpDir, "server.js"), SERVER_JS);
  fs.writeFileSync(path.join(tmpDir, "index.html"), INDEX_HTML);
  fs.writeFileSync(path.join(tmpDir, "ctv-view.html"), CTV_VIEW_HTML_SRC);

  const serverPort = 34568;
  let combinedLogs = "";
  const child = spawn(process.execPath, [path.join(tmpDir, "server.js")], {
    cwd: tmpDir,
    env: {
      ...process.env,
      ACCESSTRADE_KEY: "",
      SUPABASE_URL: "",
      SUPABASE_KEY: "",
      PORT: String(serverPort),
      ALLOWED_ORIGIN: "https://dashboard.example.vn",
      AT_BASE: `http://127.0.0.1:${mockPort}`,
      SHORTENER_TEST_BASE: `http://127.0.0.1:${mockPort}`,
      ISGD_API_BASE: `http://127.0.0.1:${mockPort}`,
      TINYURL_API_BASE: `http://127.0.0.1:${mockPort}`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    combinedLogs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    combinedLogs += chunk.toString();
  });

  try {
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      async function poll() {
        try {
          const r = await fetch(`http://127.0.0.1:${serverPort}/api/health`);
          if (r.ok) return resolve();
        } catch { }
        if (Date.now() > deadline) return reject(new Error("server.js did not start in time"));
        setTimeout(poll, 50);
      }
      poll();
    });

    // 1. Health check reports hasServerKey: false
    const healthRes = await fetch(`http://127.0.0.1:${serverPort}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.deepEqual(await healthRes.json(), { ok: true, hasServerKey: false });

    // 2. Missing X-AccessTrade-Key and no env key returns 400
    const missingKeyRes = await fetch(
      `http://127.0.0.1:${serverPort}/api/transactions?since=2026-11-01&until=2026-11-21`
    );
    assert.equal(missingKeyRes.status, 400);

    // 3. Valid X-AccessTrade-Key header A fetches 125 paginated rows
    const resA1 = await fetch(
      `http://127.0.0.1:${serverPort}/api/transactions?since=2026-11-01&until=2026-11-21`,
      { headers: { "X-AccessTrade-Key": HEADER_KEY_A } }
    );
    assert.equal(resA1.status, 200);
    const jsonA1 = await resA1.json();
    assert.equal(jsonA1.data.length, 125);
    assert.equal(jsonA1.data[0].merchant, "Thẻ Alpha");
    assert.equal(upstreamCalls, 2);
    assert.equal(capturedAuth, `Token ${HEADER_KEY_A}`);
    assert.equal(capturedContentType, "application/json");

    // 4. Cached hit for key A
    const resA2 = await fetch(
      `http://127.0.0.1:${serverPort}/api/transactions?since=2026-11-01&until=2026-11-21`,
      { headers: { "X-AccessTrade-Key": HEADER_KEY_A } }
    );
    assert.equal(resA2.status, 200);
    assert.equal(upstreamCalls, 2);

    // 5. Key B with same date range bypasses key A's cache!
    const resB1 = await fetch(
      `http://127.0.0.1:${serverPort}/api/transactions?since=2026-11-01&until=2026-11-21`,
      { headers: { "X-AccessTrade-Key": HEADER_KEY_B } }
    );
    assert.equal(resB1.status, 200);
    const jsonB1 = await resB1.json();
    assert.equal(jsonB1.data[0].merchant, "Thẻ Beta");
    assert.equal(upstreamCalls, 4);

    // 6. POST /api/create-link proxies /v1/product_link/create safely without leaking key
    const createLinkRes = await fetch(`http://127.0.0.1:${serverPort}/api/create-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AccessTrade-Key": HEADER_KEY_A
      },
      body: JSON.stringify({
        campaign_id: "6997817930567730686",
        target_url: "https://tinvay.vietcredit.com.vn/"
      })
    });
    assert.equal(createLinkRes.status, 200);
    const createLinkJson = await createLinkRes.json();
    assert.match(
      createLinkJson.aff_link,
      /^https:\/\/go\.isclix\.com\/deep_link\/4608706208340350795\/6997817930567730686/
    );

    // 7. POST /api/create-link rejects invalid campaign_id
    const badCampRes = await fetch(`http://127.0.0.1:${serverPort}/api/create-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AccessTrade-Key": HEADER_KEY_A
      },
      body: JSON.stringify({
        campaign_id: "AT72050",
        target_url: "https://tinvay.vietcredit.com.vn/"
      })
    });
    assert.equal(badCampRes.status, 400);

    // 7b. POST /api/resolve-short-link expands shorten.asia safely and blocks non-allowlisted SSRF hosts
    const resolveShortRes = await fetch(`http://127.0.0.1:${serverPort}/api/resolve-short-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://shorten.asia/47RUQaAe" })
    });
    assert.equal(resolveShortRes.status, 200);
    const resolveShortJson = await resolveShortRes.json();
    assert.equal(
      resolveShortJson.resolved_url,
      "https://go.isclix.com/deep_link/v6/4876420781540702864/6997817930567730686?sub4=oneatweb&url_enc=aHR0cHM6Ly90aW52YXkudmlldGNyZWRpdC5jb20udm4v"
    );

    const blockedSsrfRes = await fetch(`http://127.0.0.1:${serverPort}/api/resolve-short-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://evil.example.com/steal" })
    });
    assert.equal(blockedSsrfRes.status, 400);

    // 7c. POST /api/shorten-link supports AccessTrade short_link with sub2, is.gd, TinyURL fallback, and blocks invalid targets
    const fullCtvUrl =
      "https://go.isclix.com/deep_link/v6/4876420781540702864/6997817930567730686?sub4=oneatweb&url_enc=aHR0cHM6Ly90aW52YXkudmlldGNyZWRpdC5jb20udm4v&sub2=ab23cd45";

    const shortenAtRes = await fetch(`http://127.0.0.1:${serverPort}/api/shorten-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AccessTrade-Key": HEADER_KEY_A
      },
      body: JSON.stringify({
        full_url: fullCtvUrl,
        provider: "accesstrade",
        campaign_id: "6997817930567730686",
        target_url: "https://tinvay.vietcredit.com.vn/",
        sub_field: "sub2",
        sub_value: "ab23cd45"
      })
    });
    assert.equal(shortenAtRes.status, 200);
    const shortenAtJson = await shortenAtRes.json();
    assert.equal(shortenAtJson.short_url, "https://shorten.asia/atMock99");
    assert.equal(shortenAtJson.provider, "accesstrade");
    assert.equal(lastCreateLinkPayload.sub2, "ab23cd45");
    assert.equal(lastCreateLinkPayload.sub4, "oneatweb");

    // Mode auto without Access Key falls back to is.gd
    const shortenAutoIsGd = await fetch(`http://127.0.0.1:${serverPort}/api/shorten-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_url: fullCtvUrl,
        provider: "auto",
        campaign_id: "6997817930567730686",
        target_url: "https://tinvay.vietcredit.com.vn/",
        sub_field: "sub2",
        sub_value: "ab23cd45"
      })
    });
    assert.equal(shortenAutoIsGd.status, 200);
    const shortenIsGdJson = await shortenAutoIsGd.json();
    assert.equal(shortenIsGdJson.short_url, "https://is.gd/mock123");
    assert.equal(shortenIsGdJson.provider, "isgd");

    // Resolve generated is.gd URL back to go.isclix.com verifying sub2=ab23cd45
    const verifyIsGdRes = await fetch(`http://127.0.0.1:${serverPort}/api/resolve-short-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: shortenIsGdJson.short_url })
    });
    assert.equal(verifyIsGdRes.status, 200);
    const verifyIsGdJson = await verifyIsGdRes.json();
    assert.equal(new URL(verifyIsGdJson.resolved_url).searchParams.get("sub2"), "ab23cd45");

    // Mode auto when is.gd fails falls back to TinyURL
    mockIsGdShouldFail = true;
    const shortenAutoTiny = await fetch(`http://127.0.0.1:${serverPort}/api/shorten-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_url: fullCtvUrl,
        provider: "auto",
        sub_field: "sub2",
        sub_value: "ab23cd45"
      })
    });
    assert.equal(shortenAutoTiny.status, 200);
    const shortenTinyJson = await shortenAutoTiny.json();
    assert.equal(shortenTinyJson.short_url, "https://tinyurl.com/mock456");
    assert.equal(shortenTinyJson.provider, "tinyurl");
    mockIsGdShouldFail = false;

    // Reject non-AccessTrade URLs & mismatched sub_value
    const blockedShortRes = await fetch(`http://127.0.0.1:${serverPort}/api/shorten-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_url: "https://evil.example.com/phish?sub2=ab23cd45",
        provider: "isgd",
        sub_field: "sub2",
        sub_value: "ab23cd45"
      })
    });
    assert.equal(blockedShortRes.status, 400);

    const mismatchSubRes = await fetch(`http://127.0.0.1:${serverPort}/api/shorten-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_url: fullCtvUrl,
        provider: "isgd",
        sub_field: "sub2",
        sub_value: "wrongref"
      })
    });
    assert.equal(mismatchSubRes.status, 400);

    // 7d. CTV viewer page & bridge sync + strict per-CTV isolation
    const viewPageRes = await fetch(`http://127.0.0.1:${serverPort}/xem/minhviewcode1234`);
    assert.equal(viewPageRes.status, 200);
    assert.match(await viewPageRes.text(), /Hồ sơ cộng tác viên/);

    const syncRes = await fetch(`http://127.0.0.1:${serverPort}/api/ctv-bridge/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AccessTrade-Key": HEADER_KEY_A
      },
      body: JSON.stringify({
        mode: "demo",
        ctvList: [
          { id: "c1", name: "Minh", ref: "ab23cd45", view: "minhviewcode1234567890", active: true },
          { id: "c2", name: "Lan", ref: "xy78zw92", view: "lanviewcode12345678901", active: false }
        ],
        ctvLinkConfig: {
          publisher: "4608706208340350795",
          campaign: "6997817930567730686",
          targetUrl: "https://tinvay.vietcredit.com.vn/",
          salesLinkMode: "short_auto"
        },
        ctvShortLinks: {
          "short_auto|https://go.isclix.com/deep_link/4608706208340350795/6997817930567730686?url=https%3A%2F%2Ftinvay.vietcredit.com.vn%2F&sub2=ab23cd45": {
            shortUrl: "https://is.gd/minhshort",
            fullUrl: "https://go.isclix.com/deep_link/4608706208340350795/6997817930567730686?url=https%3A%2F%2Ftinvay.vietcredit.com.vn%2F&sub2=ab23cd45"
          }
        },
        policy: {
          ownerName: "Dasboard Fin",
          ctvField: "sub2",
          defaultRisk: "high",
          atRates: { low: 2.45, medium: 1.93, high: 1.58 },
          ctvRates: { low: 1.8, medium: 1.28, high: 1.0 },
          leadRisks: { "LEAD-M1": "low" }
        },
        leads: [
          {
            conversionId: "LEAD-M1",
            campaignName: "Tin Vay VietCredit",
            timeRaw: "2026-11-22 10:00:00",
            commission: 490000,
            statusKey: "approved",
            subs: { sub2: "ab23cd45" },
            apiRiskLevel: ""
          },
          {
            conversionId: "LEAD-M2-CANCELLED",
            campaignName: "Thẻ VPBank",
            timeRaw: "2026-11-21 09:00:00",
            commission: 300000,
            statusKey: "cancelled",
            subs: { sub2: "ab23cd45" },
            apiRiskLevel: ""
          },
          {
            conversionId: "LEAD-OTHER-CTV",
            campaignName: "Thẻ VIB",
            timeRaw: "2026-11-22 11:00:00",
            commission: 600000,
            statusKey: "approved",
            subs: { sub2: "xy78zw92" },
            apiRiskLevel: ""
          }
        ]
      })
    });
    assert.equal(syncRes.status, 200);

    const viewDataRes = await fetch(`http://127.0.0.1:${serverPort}/api/view/minhviewcode1234567890`);
    assert.equal(viewDataRes.status, 200);
    assert.equal(viewDataRes.headers.get("x-ctv-bridge"), "1");
    const viewJsonText = await viewDataRes.text();
    assert.equal(viewJsonText.includes(HEADER_KEY_A), false);
    assert.equal(viewJsonText.includes("LEAD-OTHER-CTV"), false);
    assert.equal(viewJsonText.includes("1.58"), false);
    assert.equal(viewJsonText.includes("490000"), false);

    const viewData = JSON.parse(viewJsonText);
    assert.equal(viewData.name, "Minh");
    assert.equal(viewData.short_link, "https://is.gd/minhshort");
    assert.equal(viewData.totals.total, 2);
    assert.equal(viewData.totals.approved, 1);
    assert.equal(viewData.totals.cancelled, 1);
    // Expected commission KPI stays visible (360000); per-order commission is hidden and order IDs truncated to 6 chars
    assert.equal(viewData.totals.commission, 360000);
    assert.equal(viewData.orders.length, 2);
    assert.equal(viewData.orders[0].commission, undefined);
    assert.ok(viewData.orders[0].id.length <= 6);

    // Retired or unknown view codes return 404 with bridge header
    const retiredRes = await fetch(`http://127.0.0.1:${serverPort}/api/view/lanviewcode12345678901`);
    assert.equal(retiredRes.status, 404);
    assert.equal(retiredRes.headers.get("x-ctv-bridge"), "1");

    // 7e. First-party click tracking (/l/:ref), bot/prefetch filtering, /api/ctv-clicks, & /l/:ref shortening
    const trackedSyncRes = await fetch(`http://127.0.0.1:${serverPort}/api/ctv-bridge/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AccessTrade-Key": HEADER_KEY_A
      },
      body: JSON.stringify({
        mode: "demo",
        ctvList: [
          { id: "c1", name: "Minh", ref: "ab23cd45", view: "minhviewcode1234567890", active: true },
          { id: "c2", name: "Lan", ref: "xy78zw92", view: "lanviewcode12345678901", active: false }
        ],
        ctvLinkConfig: {
          publisher: "4608706208340350795",
          campaign: "6997817930567730686",
          targetUrl: "https://tinvay.vietcredit.com.vn/",
          viewBase: "https://bridge.example.vn",
          salesLinkMode: "short_auto",
          trackClicks: true
        },
        ctvShortLinks: {},
        policy: {
          ownerName: "Dasboard Fin",
          ctvField: "sub2",
          defaultRisk: "high",
          atRates: { low: 2.45, medium: 1.93, high: 1.58 },
          ctvRates: { low: 1.8, medium: 1.28, high: 1.0 },
          leadRisks: { "LEAD-M1": "low" }
        },
        leads: []
      })
    });
    assert.equal(trackedSyncRes.status, 200);
    const trackedSyncJson = await trackedSyncRes.json();
    assert.equal(trackedSyncJson.clicksByRef.ab23cd45.total, 0);

    const viewBeforeClickRes = await fetch(`http://127.0.0.1:${serverPort}/api/view/minhviewcode1234567890`);
    assert.equal(viewBeforeClickRes.status, 200);
    const viewBeforeClick = await viewBeforeClickRes.json();
    assert.equal(viewBeforeClick.totals.clicks, 0);
    assert.equal(viewBeforeClick.totals.clicks_today, 0);
    assert.equal(viewBeforeClick.short_link, "https://bridge.example.vn/l/ab23cd45");

    // HEAD, prefetch, and link-preview bots redirect without incrementing clicks
    const headClickRes = await fetch(`http://127.0.0.1:${serverPort}/l/ab23cd45`, {
      method: "HEAD",
      redirect: "manual"
    });
    assert.equal(headClickRes.status, 302);

    const prefetchClickRes = await fetch(`http://127.0.0.1:${serverPort}/l/ab23cd45`, {
      method: "GET",
      redirect: "manual",
      headers: { Purpose: "prefetch", "User-Agent": "Mozilla/5.0" }
    });
    assert.equal(prefetchClickRes.status, 302);

    const zaloBotRes = await fetch(`http://127.0.0.1:${serverPort}/l/ab23cd45`, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "Zalo/1.0" }
    });
    assert.equal(zaloBotRes.status, 302);

    const fbBotRes = await fetch(`http://127.0.0.1:${serverPort}/l/ab23cd45`, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "facebookexternalhit/1.1" }
    });
    assert.equal(fbBotRes.status, 302);

    const zeroClicksRes = await fetch(`http://127.0.0.1:${serverPort}/api/ctv-clicks`);
    assert.equal(zeroClicksRes.status, 200);
    const zeroClicksJson = await zeroClicksRes.json();
    assert.equal(zeroClicksJson.clicksByRef.ab23cd45.total, 0);

    // Real human GET increments real persisted clicks and returns 302 with no-store
    const realClickRes = await fetch(`http://127.0.0.1:${serverPort}/l/ab23cd45`, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }
    });
    assert.equal(realClickRes.status, 302);
    const clickLocation = realClickRes.headers.get("location") || "";
    assert.match(clickLocation, /^https:\/\/go\.isclix\.com\/deep_link\/4608706208340350795\/6997817930567730686/);
    assert.equal(new URL(clickLocation).searchParams.get("sub2"), "ab23cd45");
    assert.match(realClickRes.headers.get("cache-control") || "", /no-store/);

    const oneClickRes = await fetch(`http://127.0.0.1:${serverPort}/api/ctv-clicks`);
    const oneClickJson = await oneClickRes.json();
    assert.equal(oneClickJson.clicksByRef.ab23cd45.total, 1);
    assert.equal(oneClickJson.clicksByRef.ab23cd45.today, 1);
    assert.ok(oneClickJson.clicksByRef.ab23cd45.lastClickAt);

    const viewAfterClickRes = await fetch(`http://127.0.0.1:${serverPort}/api/view/minhviewcode1234567890`);
    const viewAfterClick = await viewAfterClickRes.json();
    assert.equal(viewAfterClick.totals.clicks, 1);
    assert.equal(viewAfterClick.totals.clicks_today, 1);
    assert.ok(viewAfterClick.last_click_at);

    // Unknown or inactive CTV refs return 404
    const unknownRefRes = await fetch(`http://127.0.0.1:${serverPort}/l/notexist9`, { redirect: "manual" });
    assert.equal(unknownRefRes.status, 404);
    const inactiveRefRes = await fetch(`http://127.0.0.1:${serverPort}/l/xy78zw92`, { redirect: "manual" });
    assert.equal(inactiveRefRes.status, 404);

    // Re-syncing bridge preserves clickStats and returns clicksByRef
    const resyncRes = await fetch(`http://127.0.0.1:${serverPort}/api/ctv-bridge/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "demo",
        ctvList: [{ id: "c1", name: "Minh", ref: "ab23cd45", view: "minhviewcode1234567890", active: true }],
        ctvLinkConfig: {
          publisher: "4608706208340350795",
          campaign: "6997817930567730686",
          targetUrl: "https://tinvay.vietcredit.com.vn/",
          viewBase: "https://bridge.example.vn",
          salesLinkMode: "short_auto",
          trackClicks: true
        },
        ctvShortLinks: {},
        policy: { ownerName: "Dasboard Fin", ctvField: "sub2", defaultRisk: "high" },
        leads: []
      })
    });
    assert.equal(resyncRes.status, 200);
    const resyncJson = await resyncRes.json();
    assert.equal(resyncJson.clicksByRef.ab23cd45.total, 1);

    // Shortening /l/<ref> works with auto/is.gd and rejects accesstrade or mismatched ref
    const shortenBridgeRes = await fetch(`http://127.0.0.1:${serverPort}/api/shorten-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_url: "https://bridge.example.vn/l/ab23cd45",
        provider: "auto",
        sub_field: "sub2",
        sub_value: "ab23cd45"
      })
    });
    assert.equal(shortenBridgeRes.status, 200);
    const shortenBridgeJson = await shortenBridgeRes.json();
    assert.equal(shortenBridgeJson.short_url, "https://is.gd/mock123");

    // Shortening /xem/<viewCode> produces Dashboard-branded is.gd link
    const shortenViewRes = await fetch(`http://127.0.0.1:${serverPort}/api/shorten-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_url: "https://bridge.example.vn/xem/minhviewcode1234567890",
        provider: "isgd",
        project_key: "dashboard"
      })
    });
    assert.equal(shortenViewRes.status, 200);
    const shortenViewJson = await shortenViewRes.json();
    assert.equal(shortenViewJson.short_url, "https://is.gd/mock123");
    assert.equal(shortenViewJson.provider_label, "is.gd (Dashboard)");

    const shortenBridgeAtReject = await fetch(`http://127.0.0.1:${serverPort}/api/shorten-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AccessTrade-Key": HEADER_KEY_A
      },
      body: JSON.stringify({
        full_url: "https://bridge.example.vn/l/ab23cd45",
        provider: "accesstrade",
        campaign_id: "6997817930567730686",
        sub_field: "sub2",
        sub_value: "ab23cd45"
      })
    });
    assert.equal(shortenBridgeAtReject.status, 400);

    const shortenBridgeMismatch = await fetch(`http://127.0.0.1:${serverPort}/api/shorten-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_url: "https://bridge.example.vn/l/ab23cd45",
        provider: "isgd",
        sub_field: "sub2",
        sub_value: "otherref"
      })
    });
    assert.equal(shortenBridgeMismatch.status, 400);

    // 8. Upstream 401 returns clear 502 Vietnamese auth error without leaking key
    upstreamStatus = 401;
    const authErrRes = await fetch(
      `http://127.0.0.1:${serverPort}/api/transactions?since=2026-10-01&until=2026-10-15`,
      { headers: { "X-AccessTrade-Key": HEADER_KEY_A } }
    );
    assert.equal(authErrRes.status, 502);
    const authErrBody = await authErrRes.text();
    assert.match(authErrBody, /Access Key không hợp lệ/);
    assert.equal(authErrBody.includes(HEADER_KEY_A), false);
    assert.equal(combinedLogs.includes(HEADER_KEY_A), false);
    assert.equal(combinedLogs.includes(HEADER_KEY_B), false);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on("exit", () => resolve());
      setTimeout(resolve, 500);
    });
    await new Promise((resolve) => mockAtServer.close(resolve));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { }
  }
});

test("Security Method 3: ADMIN_SECRET locks admin APIs, bootstrap never leaks accessKey or CTV view codes, and CTV routes remain public", async () => {
  const ADMIN_PASS = "admin-pass-strong-987";
  const SECRET_AT_KEY = "at-secret-should-never-leak-to-client";
  const SECRET_VIEW_CODE = "minhsecretviewcode998877";

  const modServer = (await import("../server.js")).default;
  assert.equal(typeof modServer.maskOrderId, "function");
  assert.equal(modServer.maskOrderId("494045787"), "494045787", "VietCredit numeric ID must stay unchanged");
  assert.equal(modServer.maskOrderId("nguyenminhhieu034*******"), "ng*****hieu034*******");
  assert.equal(modServer.maskOrderId("ng*****hieu034*******"), "ng*****hieu034*******");
  assert.equal(modServer.maskOrderId("an091*******"), "an*****091*******");
  assert.equal(modServer.maskOrderId("ORD1234567890"), "OR*****7890");
  assert.equal(modServer.maskOrderId("Nguyen Van A"), "Ng*****an A");
  assert.equal(modServer.maskOrderId(""), "");

  const mockSupabase = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const p = reqUrl.pathname;
    if (p.includes("ctv_clicks")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          { ref: "minh88", total: 17, by_day: {}, last_click_at: "2026-11-28T09:00:00Z" }
        ])
      );
      return;
    }
    if (p.includes("ctvs")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          { id: "c1", name: "Minh", ref: "minh88", view_code: SECRET_VIEW_CODE, active: true }
        ])
      );
      return;
    }
    if (p.includes("app_settings")) {
      const k = (reqUrl.searchParams.get("key") || "").replace(/^eq\./, "");
      if (k === "ctv_config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            {
              key: "ctv_config",
              value: {
                mode: "real",
                accessKey: SECRET_AT_KEY,
                ctvList: [{ id: "c1", name: "Minh", ref: "minh88", view: SECRET_VIEW_CODE, active: true }],
                ctvLinkConfig: {
                  publisher: "4608706208340350795",
                  campaign: "6997817930567730686",
                  targetUrl: "https://tinvay.vietcredit.com.vn/"
                },
                policy: { ownerName: "Dasboard Fin", ctvField: "sub2", defaultRisk: "high" }
              }
            }
          ])
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }
    if (p.includes("conversions")) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Range": "0-0/1"
      });
      res.end(
        JSON.stringify([
          {
            conversion_id: 777001,
            sales_time: "2026-11-27T09:00:00+07:00",
            order_id: "nguyenminhhieu034*******",
            order_value: 20000000,
            advertiser: "tnex_vay",
            commission: 250000,
            status: 1,
            is_confirmed: 0,
            ctv_ref: "minh88",
            tracking: {
              sub2: "minh88",
              extra: { device: "Android", phone: "0341234567" }
            }
          }
        ])
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([]));
  });

  await new Promise((r) => mockSupabase.listen(0, "127.0.0.1", r));
  const sbPort = mockSupabase.address().port;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "df-admin-auth-"));
  fs.writeFileSync(path.join(tmpDir, "server.js"), SERVER_JS);
  fs.writeFileSync(path.join(tmpDir, "index.html"), INDEX_HTML);
  fs.writeFileSync(path.join(tmpDir, "ctv-view.html"), CTV_VIEW_HTML_SRC);

  const child = spawn(process.execPath, [path.join(tmpDir, "server.js")], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PORT: "0",
      SUPABASE_URL: `http://127.0.0.1:${sbPort}`,
      SUPABASE_KEY: "mock-anon",
      SUPABASE_SERVICE_ROLE_KEY: "mock-service-role",
      ADMIN_SECRET: ADMIN_PASS
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverPort = null;
  const started = new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = d.toString().match(/http:\/\/localhost:(\d+)/i);
      if (m && !serverPort) {
        serverPort = Number(m[1]);
        resolve();
      }
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("server.js timed out")), 10000);
  });

  try {
    await started;
    const base = `http://127.0.0.1:${serverPort}`;

    // 1. All admin endpoints return 401 when unauthenticated
    const adminEndpoints = [
      { method: "GET", path: "/api/admin/bootstrap" },
      { method: "GET", path: "/api/admin/ctv-views" },
      { method: "GET", path: "/api/conversions" },
      { method: "GET", path: "/api/transactions?since=2026-11-01&until=2026-11-27" },
      { method: "GET", path: "/api/ctv-clicks" },
      { method: "POST", path: "/api/ctv-bridge/sync", body: "{}" },
      { method: "POST", path: "/api/ctv-bridge/delete", body: "{}" },
      { method: "POST", path: "/api/create-link", body: "{}" },
      { method: "POST", path: "/api/resolve-short-link", body: "{}" },
      { method: "POST", path: "/api/shorten-link", body: "{}" }
    ];
    for (const ep of adminEndpoints) {
      const r = await fetch(base + ep.path, {
        method: ep.method,
        headers: ep.body ? { "Content-Type": "application/json" } : {},
        body: ep.body
      });
      assert.equal(r.status, 401, `${ep.method} ${ep.path} must return 401 without ADMIN_SECRET`);
      const errJson = await r.json();
      assert.equal(errJson.requiresAdminAuth, true);
    }

    // 2. Public CTV & tracking routes STILL work without ADMIN_SECRET
    const homeRes = await fetch(base + "/");
    assert.equal(homeRes.status, 200);
    assert.match(homeRes.headers.get("x-robots-tag") || "", /noindex/i);
    const ctvHtmlRes = await fetch(base + `/xem/${SECRET_VIEW_CODE}`);
    assert.equal(ctvHtmlRes.status, 200);
    const viewApiRes = await fetch(base + `/api/view/${SECRET_VIEW_CODE}`);
    assert.equal(viewApiRes.status, 200);
    const viewPayloadText = await viewApiRes.text();
    assert.equal(viewPayloadText.includes(SECRET_AT_KEY), false);
    assert.equal(viewPayloadText.includes("nguyenminhhieu"), false, "Raw order_id PII must NEVER leak on /api/view");
    const viewPayload = JSON.parse(viewPayloadText);
    assert.equal(viewPayload.orders[0].id, "ng*****hieu034*******");
    assert.equal(viewPayload.totals.clicks, 17, "CTV view must load realtime clicks directly from Supabase ctv_clicks");
    const redirRes = await fetch(base + "/l/minh88", { redirect: "manual" });
    assert.equal(redirRes.status, 302);
    assert.match(redirRes.headers.get("location") || "", /sub2=minh88/);

    // 3. Authenticated /api/admin/bootstrap works AND never leaks accessKey or CTV view codes
    const bootRes = await fetch(base + "/api/admin/bootstrap", {
      headers: { "X-Admin-Secret": ADMIN_PASS }
    });
    assert.equal(bootRes.status, 200);
    const bootRawText = await bootRes.text();
    assert.equal(bootRawText.includes(SECRET_AT_KEY), false, "accessKey MUST NEVER appear in bootstrap response");
    assert.equal(bootRawText.includes(SECRET_VIEW_CODE), false, "CTV view codes MUST NEVER appear in bootstrap response");
    const bootJson = JSON.parse(bootRawText);
    assert.equal(bootJson.adminAuthEnabled, true);
    assert.equal(bootJson.hasAccessKey, true);
    assert.equal(bootJson.ctvList[0].view, undefined);
    assert.equal(bootJson.settings.accessKey, undefined);

    // 4. Authenticated /api/admin/ctv-views returns viewsByRef
    const viewsRes = await fetch(base + "/api/admin/ctv-views", {
      headers: { Authorization: "Bearer " + ADMIN_PASS }
    });
    assert.equal(viewsRes.status, 200);
    const viewsJson = await viewsRes.json();
    assert.equal(viewsJson.viewsByRef.minh88, SECRET_VIEW_CODE);

    // 5. Authenticated /api/conversions masks unmasked rows on read & strips tracking.extra
    const convRes = await fetch(base + "/api/conversions", {
      headers: { "X-Admin-Secret": ADMIN_PASS }
    });
    assert.equal(convRes.status, 200);
    const convText = await convRes.text();
    assert.equal(convText.includes("nguyenminhhieu"), false);
    assert.equal(convText.includes("0341234567"), false);
    const convJson = JSON.parse(convText);
    assert.equal(convJson.rows[0].order_id, "ng*****hieu034*******");
    assert.equal("extra" in convJson.rows[0].tracking, false);

    // 6. Brute-force protection locks after 5 invalid admin guesses
    for (let i = 0; i < 5; i += 1) {
      await fetch(base + "/api/admin/bootstrap", {
        headers: { "X-Admin-Secret": "wrong-guess-" + i }
      });
    }
    const lockedRes = await fetch(base + "/api/admin/bootstrap", {
      headers: { "X-Admin-Secret": ADMIN_PASS }
    });
    assert.equal(lockedRes.status, 429);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on("exit", () => resolve());
      setTimeout(resolve, 500);
    });
    await new Promise((resolve) => mockSupabase.close(resolve));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { }
  }
});

test("Admin login gate in index.html locks .app-shell on 401, unlocks via sessionStorage only, and hydrates CTV views", async () => {
  const scriptMatch = INDEX_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, "Expected inline <script> in index.html");
  let scriptBody = scriptMatch[1];
  scriptBody = scriptBody.replace(
    "applyBranding();",
    `globalThis.__AUTH_TEST__ = { state, bindEvents, bootstrapFromCloud, fetchAdminCtvViews, showAdminAuthGate, hideAdminAuthGate, getSessionAdminSecret, setSessionAdminSecret };
    return;`
  );

  const elements = new Map();
  const makeEl = (id) => {
    const listeners = {};
    const el = {
      id,
      textContent: "",
      innerHTML: "",
      hidden: id === "admin-auth-gate" || id === "btn-admin-logout",
      className: "",
      value: "",
      type: "password",
      disabled: false,
      style: {},
      attributes: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      setAttribute(k, v) { el.attributes[k] = String(v); },
      getAttribute(k) { return el.attributes[k] || ""; },
      appendChild() {},
      removeChild() {},
      focus() {},
      select() {},
      setSelectionRange() {},
      addEventListener(ev, fn) {
        if (!listeners[ev]) listeners[ev] = [];
        listeners[ev].push(fn);
      },
      async trigger(ev, evObj) {
        for (const fn of (listeners[ev] || [])) {
          await fn(evObj || { preventDefault() {}, currentTarget: el, target: el });
        }
      },
      querySelectorAll() { return []; },
      querySelector() { return null; }
    };
    return el;
  };
  for (const id of ["admin-auth-gate", "app-shell", "btn-admin-logout", "admin-login-form", "input-admin-secret", "btn-admin-login", "admin-login-feedback", "btn-toggle-admin-secret", "app-toast"]) {
    elements.set(id, makeEl(id));
  }

  const localStore = {};
  const sessionStore = {};
  const fetchCalls = [];
  const context = vm.createContext({
    window: {
      location: { protocol: "https:", origin: "https://dash.example.vn" },
      crypto: globalThis.crypto,
      setTimeout: (fn) => { fn(); return 1; },
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      localStorage: {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(localStore, k) ? localStore[k] : null),
        setItem: (k, v) => { localStore[k] = String(v); },
        removeItem: (k) => { delete localStore[k]; }
      },
      sessionStorage: {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(sessionStore, k) ? sessionStore[k] : null),
        setItem: (k, v) => { sessionStore[k] = String(v); },
        removeItem: (k) => { delete sessionStore[k]; }
      },
      fetch: async (url, opts) => {
        const hdrs = (opts && opts.headers) || {};
        fetchCalls.push({ url: String(url), adminSecret: hdrs["X-Admin-Secret"] || "" });
        if (String(url).includes("/api/admin/bootstrap")) {
          if (hdrs["X-Admin-Secret"] !== "valid-admin-pass") {
            return {
              ok: false,
              status: 401,
              json: async () => ({ error: "Cần đăng nhập để truy cập trang quản trị.", requiresAdminAuth: true })
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              adminAuthEnabled: true,
              hasAccessKey: true,
              ctvList: [{ id: "c1", name: "Minh", ref: "minh88", active: true }],
              settings: null,
              clicksByRef: {}
            })
          };
        }
        if (String(url).includes("/api/admin/ctv-views")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, viewsByRef: { minh88: "viewcodefromadminapi1234" } })
          };
        }
        if (String(url).includes("/api/transactions")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [] })
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, available: true, rows: [], totalInSupabase: 0 }) };
      }
    },
    document: {
      visibilityState: "visible",
      documentElement: { setAttribute() {}, removeAttribute() {} },
      addEventListener: () => {},
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, makeEl(id));
        return elements.get(id);
      },
      querySelectorAll: () => [],
      createElement: () => makeEl("")
    },
    crypto: globalThis.crypto,
    Uint8Array,
    Intl,
    Date,
    Number,
    String,
    Array,
    Math,
    URL,
    JSON
  });

  vm.runInContext(scriptBody, context);
  const auth = context.__AUTH_TEST__;
  auth.bindEvents();

  // 1. Unauthenticated bootstrap -> requires login gate, keeps app-shell hidden
  const bootUnauth = await auth.bootstrapFromCloud();
  assert.equal(bootUnauth.ok, false);
  assert.equal(bootUnauth.authRequired, true);
  auth.showAdminAuthGate("");
  assert.equal(elements.get("app-shell").hidden, true);
  assert.equal(elements.get("admin-auth-gate").hidden, false);

  // 2. Wrong password rejected
  elements.get("input-admin-secret").value = "wrong-pass";
  await elements.get("admin-login-form").trigger("submit");
  assert.equal(auth.getSessionAdminSecret(), "");
  assert.equal(elements.get("app-shell").hidden, true);
  assert.equal(elements.get("admin-login-feedback").hidden, false);

  // 3. Valid password unlocks, persists ONLY in sessionStorage (NOT localStorage), and fetches CTV view codes
  elements.get("input-admin-secret").value = "valid-admin-pass";
  await elements.get("admin-login-form").trigger("submit");
  assert.equal(auth.getSessionAdminSecret(), "valid-admin-pass");
  assert.equal(JSON.stringify(localStore).includes("valid-admin-pass"), false, "ADMIN_SECRET must NEVER be written to localStorage");
  assert.equal(elements.get("app-shell").hidden, false);
  assert.equal(elements.get("admin-auth-gate").hidden, true);
  assert.equal(elements.get("btn-admin-logout").hidden, false);
  assert.equal(auth.state.ctvList[0].view, "viewcodefromadminapi1234");
  assert.equal(auth.state.serverHasAccessKey, true);

  // 4. Logout locks UI and clears sessionStorage
  await elements.get("btn-admin-logout").trigger("click");
  assert.equal(auth.getSessionAdminSecret(), "");
  assert.equal(elements.get("app-shell").hidden, true);
  assert.equal(elements.get("admin-auth-gate").hidden, false);
});
