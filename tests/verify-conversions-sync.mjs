import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const INDEX_HTML = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
const CTV_VIEW_HTML = fs.readFileSync(path.join(process.cwd(), "ctv-view.html"), "utf8");

test("Conversions sync engine handles secrets, rate limits, retries, upsert mapping, backfill stop, lock, smart masking, and CTV privacy", async () => {
  // Static privacy, security & auto-sync/polling checks on HTML files
  assert.doesNotMatch(INDEX_HTML, /localStorage\.setItem\([^)]*SYNC_SECRET/i);
  assert.doesNotMatch(INDEX_HTML, /localStorage\.setItem\([^)]*ADMIN_SECRET/i);
  assert.doesNotMatch(INDEX_HTML, /id="select-sync-mode"/);
  assert.match(INDEX_HTML, /id="admin-auth-gate"/);
  assert.match(INDEX_HTML, /ADMIN_SECRET_SESSION_KEY/);
  assert.match(INDEX_HTML, /sessionStorage/);
  assert.match(INDEX_HTML, /Tổng số hồ sơ trong Supabase/);
  assert.match(INDEX_HTML, /Đồng bộ ngay/);
  assert.match(INDEX_HTML, /SYNC_POLL_INTERVAL_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
  assert.match(INDEX_HTML, /ensureAutoSyncAndPolling/);
  assert.match(INDEX_HTML, /startConversionsPolling/);
  assert.match(INDEX_HTML, /visibilitychange/);
  assert.match(CTV_VIEW_HTML, /Hoa hồng dự kiến/);
  assert.doesNotMatch(CTV_VIEW_HTML, /Hoa hồng CTV nhận/);

  const conversionsDb = new Map();
  // Seed legacy unmasked Supabase row with tracking.extra to verify automatic scrubbing
  conversionsDb.set("900123400", {
    conversion_id: 900123400,
    sales_time: "2026-11-24T10:00:00+07:00",
    order_id: "tranthibich098*******",
    order_value: 10000000,
    advertiser: "tnex_vay",
    commission: 250000,
    status: 1,
    is_confirmed: 0,
    ctv_ref: "other_pub",
    tracking: {
      sub2: "other_pub",
      extra: { device: "iPhone", phone: "0981112222" }
    }
  });
  const syncStateDb = {};
  const ctvsDb = [
    { id: "c1", name: "Minh", ref: "minh88", view_code: "minhviewcode99887766", active: true }
  ];

  let atCalls = 0;
  let atModeScenario = "retry_then_ok"; // "retry_then_ok" | "always_fail" | "rate_429_then_ok"
  let failAtRemaining = 2; // fail first 2 calls with success:false / 502 then succeed
  let capturedAtHeaders = null;
  let capturedQueryParams = [];

  // 1. Mock AccessTrade + Supabase REST server
  const mockUpstream = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = reqUrl.pathname;

    // Mock AccessTrade GET /v1/transactions
    if (req.method === "GET" && pathname === "/v1/transactions") {
      atCalls += 1;
      capturedAtHeaders = req.headers;
      capturedQueryParams.push(Object.fromEntries(reqUrl.searchParams.entries()));

      if (atModeScenario === "always_fail") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, message: "Upstream busy always" }));
        return;
      }

      if (atModeScenario === "rate_429_then_ok" && failAtRemaining > 0) {
        failAtRemaining -= 1;
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, retry_after: 1 }));
        return;
      }

      if (atModeScenario === "retry_then_ok" && failAtRemaining > 0) {
        failAtRemaining -= 1;
        if (failAtRemaining === 1) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Bad gateway" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, message: "Temporary false" }));
        }
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: [
            {
              conversion_id: 900123456,
              transaction_id: "494045787",
              transaction_time: "2026-11-26 09:30:00",
              transaction_value: 25000000,
              merchant: "vcredit2026",
              commission: 550000,
              status: 1,
              is_confirmed: 0,
              update_time: "2026-11-26 10:00:00",
              _extra: { sub2: "minh88", utm_campaign: "minh88", device_brand: "Apple" }
            },
            {
              conversion_id: 900123458,
              transaction_id: "nguyenminhhieu034*******",
              transaction_time: "2026-11-26 11:15:00",
              transaction_value: 20000000,
              merchant: "tnex_vay",
              commission: 400000,
              status: 0,
              is_confirmed: 0,
              update_time: "2026-11-26 11:20:00",
              _extra: { sub2: "minh88", utm_campaign: "minh88", product_name: "TNEX" }
            },
            {
              conversion_id: 900123457,
              transaction_id: "ORD1234567890",
              transaction_time: "2026-11-26T08:15:00+07:00",
              transaction_value: 15000000,
              merchant: "TNEX - MSB",
              commission: 300000,
              status: 1,
              is_confirmed: 1,
              utm_campaign: "other_pub"
            }
          ]
        })
      );
      return;
    }

    // Read body for Supabase mocks
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");

      if (pathname === "/rest/v1/sync_state") {
        if (req.method === "GET") {
          const keyFilter = reqUrl.searchParams.get("key") || "eq.conversions_sync";
          const k = keyFilter.replace(/^eq\./, "");
          const rows = syncStateDb[k] ? [{ key: k, value: syncStateDb[k] }] : [];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rows));
          return;
        }
        if (req.method === "POST") {
          const body = JSON.parse(rawBody);
          syncStateDb[body.key] = body.value;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([body]));
          return;
        }
      }

      if (pathname === "/rest/v1/conversions") {
        if (req.method === "POST") {
          // Enforce service_role key check
          assert.equal(req.headers.apikey, "mock-service-role-key");
          const rows = JSON.parse(rawBody);
          for (const r of rows) {
            conversionsDb.set(String(r.conversion_id), r);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rows));
          return;
        }
        if (req.method === "GET") {
          let list = Array.from(conversionsDb.values());
          const orFilter = reqUrl.searchParams.get("or") || "";
          const mRef = orFilter.match(/ctv_ref\.eq\.([^,)]+)/i);
          if (mRef) {
            const targetRef = decodeURIComponent(mRef[1]).toLowerCase();
            list = list.filter((r) => String(r.ctv_ref || "").toLowerCase() === targetRef);
          }
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Range": `0-${Math.max(0, list.length - 1)}/${list.length}`
          });
          res.end(JSON.stringify(list));
          return;
        }
      }

      if (pathname === "/rest/v1/ctvs") {
        const viewFilter = reqUrl.searchParams.get("view_code") || "";
        let list = ctvsDb;
        if (viewFilter.startsWith("eq.")) {
          const vc = viewFilter.slice(3);
          list = ctvsDb.filter((c) => c.view_code === vc);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
    });
  });

  await new Promise((resolve) => mockUpstream.listen(0, "127.0.0.1", resolve));
  const mockPort = mockUpstream.address().port;

  // 2. Spawn server.js
  const child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: "0",
      AT_BASE: `http://127.0.0.1:${mockPort}`,
      SUPABASE_URL: `http://127.0.0.1:${mockPort}`,
      SUPABASE_KEY: "mock-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "mock-service-role-key",
      ACCESSTRADE_KEY: "secret-at-token-xyz",
      SYNC_SECRET: "manual-sync-secret-123",
      CRON_SECRET: "cron-auto-secret-456",
      SYNC_PACE_MS: "20",
      SYNC_TEST_FAST: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverLogs = "";
  let serverPort = null;
  const started = new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const s = d.toString();
      serverLogs += s;
      const m = s.match(/http:\/\/localhost:(\d+)/i);
      if (m && !serverPort) {
        serverPort = Number(m[1]);
        resolve();
      }
    });
    child.stderr.on("data", (d) => {
      serverLogs += d.toString();
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("server.js timed out")), 10000);
  });

  try {
    await started;

    // A. Secret separation & wrong-secret rejection
    const wrongSync = await fetch(`http://127.0.0.1:${serverPort}/api/conversions/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Secret": "cron-auto-secret-456" },
      body: JSON.stringify({ mode: "incremental" })
    });
    assert.equal(wrongSync.status, 401, "CRON_SECRET must NOT work on manual /sync endpoint");

    const wrongCron = await fetch(`http://127.0.0.1:${serverPort}/api/conversions/cron`, {
      method: "POST",
      headers: { Authorization: "Bearer manual-sync-secret-123" }
    });
    assert.equal(wrongCron.status, 401, "SYNC_SECRET must NOT work on /cron endpoint");

    // B. Incremental sync with retries (502 -> success:false -> ok) + mapping check
    const syncOkRes = await fetch(`http://127.0.0.1:${serverPort}/api/conversions/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Secret": "manual-sync-secret-123" },
      body: JSON.stringify({ mode: "incremental", limit: 200 })
    });
    assert.equal(syncOkRes.status, 200);
    const syncOkJson = await syncOkRes.json();
    assert.equal(syncOkJson.ok, true);
    assert.equal(syncOkJson.upsertedCount, 3);
    assert.equal(atCalls, 3, "Should retry twice (502 + success:false) and succeed on 3rd attempt");
    assert.equal(capturedAtHeaders.authorization, "Token secret-at-token-xyz");
    assert.ok(capturedQueryParams[0].update_time_start);
    assert.ok(capturedQueryParams[0].update_time_end);
    assert.equal(capturedQueryParams[0].limit, "200");

    // Verify mapped row in mock Supabase conversions table (smart masking + stripped extra)
    const row1 = conversionsDb.get("900123456");
    assert.ok(row1);
    assert.equal(row1.conversion_id, 900123456);
    assert.equal(row1.sales_time, "2026-11-26T09:30:00+07:00");
    assert.equal(row1.order_id, "494045787", "Purely numeric VietCredit ID must remain unmasked");
    assert.equal(row1.order_value, 25000000);
    assert.equal(row1.advertiser, "vcredit2026");
    assert.equal(row1.commission, 550000);
    assert.equal(row1.status, 1);
    assert.equal(row1.is_confirmed, 0);
    assert.equal(row1.sub2, "minh88");
    assert.equal(row1.utm_campaign, "minh88");
    assert.equal(row1.ctv_ref, "minh88");
    assert.equal(row1.ctv_source, "both");
    assert.equal(row1.ctv_conflict, false);
    assert.equal("extra" in row1.tracking, false, "tracking.extra must NOT be persisted in Supabase");

    const rowTnex = conversionsDb.get("900123458");
    assert.ok(rowTnex);
    assert.equal(rowTnex.order_id, "ng*****hieu034*******", "PII TNEX order_id must use ng*****hieu034******* smart masking before DB write");
    assert.equal("extra" in rowTnex.tracking, false);

    const rowOther = conversionsDb.get("900123457");
    assert.ok(rowOther);
    assert.equal(rowOther.order_id, "OR*****7890", "Alphanumeric order_id must use 5-star smart masking");

    const rowLegacy = conversionsDb.get("900123400");
    assert.ok(rowLegacy);
    assert.equal(rowLegacy.order_id, "tr*****bich098*******", "Legacy Supabase row must be scrubbed during sync");
    assert.equal("extra" in rowLegacy.tracking, false, "Legacy tracking.extra must be removed during sync");

    // Verify sync_state lock released and rate budget saved
    assert.equal(syncStateDb["conversions_sync"].lock.locked, false);
    assert.equal(syncStateDb["conversions_sync"].last_status, "success");
    assert.ok(syncStateDb["conversions_sync"].rate_budget.recent_requests.length >= 3);

    // C. Anti-overlap Lock enforcement
    syncStateDb["conversions_sync"].lock = {
      locked: true,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      run_id: "active-other"
    };
    const lockRes = await fetch(`http://127.0.0.1:${serverPort}/api/conversions/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Secret": "manual-sync-secret-123" },
      body: JSON.stringify({ mode: "incremental" })
    });
    assert.equal(lockRes.status, 409, "Concurrent sync must be rejected with 409 when locked");
    syncStateDb["conversions_sync"].lock.locked = false;

    // D. Backfill mode stops cleanly when a week permanently fails (success:false after 3 retries)
    atModeScenario = "always_fail";
    const bfFailRes = await fetch(`http://127.0.0.1:${serverPort}/api/conversions/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Secret": "manual-sync-secret-123" },
      body: JSON.stringify({ mode: "backfill", weekIndex: 0 })
    });
    assert.equal(bfFailRes.status, 502);
    const bfFailJson = await bfFailRes.json();
    assert.equal(bfFailJson.stop, true);
    assert.equal(syncStateDb["conversions_sync"].last_status, "error");
    assert.equal(syncStateDb["conversions_sync"].lock.locked, false);

    // E. Cron endpoint works with CRON_SECRET and 429 retry_after handling
    atModeScenario = "rate_429_then_ok";
    failAtRemaining = 1;
    const cronRes = await fetch(`http://127.0.0.1:${serverPort}/api/conversions/cron?mode=incremental`, {
      method: "GET",
      headers: { Authorization: "Bearer cron-auto-secret-456" }
    });
    assert.equal(cronRes.status, 200);
    const cronJson = await cronRes.json();
    assert.equal(cronJson.ok, true);

    // F. Admin GET /api/conversions returns totalInSupabase and rows
    const adminListRes = await fetch(`http://127.0.0.1:${serverPort}/api/conversions`);
    assert.equal(adminListRes.status, 200);
    const adminListJson = await adminListRes.json();
    assert.equal(adminListJson.totalInSupabase, 4);
    assert.equal(adminListJson.rows.length, 4);

    // G. Ensure real mode is active, then CTV /api/view/:code reads only matching ctv_ref, hides commission, preserves smart-masked ID, keeps order_value
    await fetch(`http://127.0.0.1:${serverPort}/api/ctv-bridge/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "real",
        ctvList: [{ id: "c1", name: "Minh", ref: "minh88", view: "minhviewcode99887766", active: true }],
        ctvLinkConfig: {
          publisher: "4608706208340350795",
          campaign: "6997817930567730686",
          targetUrl: "https://tinvay.vietcredit.com.vn/"
        }
      })
    });
    const ctvRes = await fetch(`http://127.0.0.1:${serverPort}/api/view/minhviewcode99887766`);
    assert.equal(ctvRes.status, 200);
    const ctvJson = await ctvRes.json();
    assert.equal(ctvJson.totals.total, 2, "Only minh88 rows should be visible to Minh");
    assert.ok(ctvJson.totals.commission > 0, "Expected commission KPI must remain visible for CTV");
    assert.equal(ctvJson.orders.length, 2);
    const byCamp = Object.fromEntries(ctvJson.orders.map((o) => [o.campaign, o]));
    assert.equal(byCamp["vcredit2026"].id, "494045", "Numeric order ID truncated to 6 chars on CTV view");
    assert.equal(byCamp["vcredit2026"].order_value, 25000000);
    assert.equal(byCamp["vcredit2026"].commission, undefined, "Order commission must be omitted on CTV payload");
    assert.equal(byCamp["tnex_vay"].id, "ng*****hieu034*******", "Full smart-masked TNEX ID stays intact so CTV can recognize customer");

    // G2. Verify /api/ctv-bridge/sync preserves existing CTV view code if client sends empty view while active, and /api/admin/ctv-views works
    await fetch(`http://127.0.0.1:${serverPort}/api/ctv-bridge/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "real",
        ctvList: [{ id: "c1", name: "Minh", ref: "minh88", view: "", active: true }]
      })
    });
    const viewsNoAuthRes = await fetch(`http://127.0.0.1:${serverPort}/api/admin/ctv-views`);
    assert.equal(viewsNoAuthRes.status, 200);
    const viewsNoAuthJson = await viewsNoAuthRes.json();
    assert.equal(viewsNoAuthJson.viewsByRef.minh88, "minhviewcode99887766", "Active CTV view_code must NEVER be wiped out by empty view sync");

    // H. Brute-force protection (5 failed attempts -> 429, blocks subsequent valid attempt)
    for (let k = 0; k < 5; k += 1) {
      await fetch(`http://127.0.0.1:${serverPort}/api/conversions/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sync-Secret": "bad-guess" },
        body: "{}"
      });
    }
    const lockedOutRes = await fetch(`http://127.0.0.1:${serverPort}/api/conversions/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Secret": "manual-sync-secret-123" },
      body: "{}"
    });
    assert.equal(lockedOutRes.status, 429, "Should block after 5 wrong secret attempts");

    // I. Verify no secret was ever printed in server logs
    assert.equal(serverLogs.includes("secret-at-token-xyz"), false);
    assert.equal(serverLogs.includes("mock-service-role-key"), false);
    assert.equal(serverLogs.includes("manual-sync-secret-123"), false);
    assert.equal(serverLogs.includes("cron-auto-secret-456"), false);
  } finally {
    child.kill();
    mockUpstream.close();
  }
});
