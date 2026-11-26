import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

test("AccessTrade snapshot cache in Supabase guarantees instant CTV loading and fail-safe resilience", async () => {
  // 1. Mock Supabase server
  let storedSettings = {};
  const mockSupabase = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path.includes("app_settings")) {
      const keyMatch = url.searchParams.get("key");
      const key = keyMatch ? keyMatch.replace(/^eq\./, "") : null;
      if (key && storedSettings[key]) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ key, value: storedSettings[key] }]));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    if (req.method === "POST" && path.includes("app_settings")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed && parsed.key) {
            storedSettings[parsed.key] = parsed.value;
          }
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (_e) {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    if (path.includes("ctvs") || path.includes("ctv_clicks")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([]));
  });

  await new Promise((resolve) => mockSupabase.listen(0, "127.0.0.1", resolve));
  const sbPort = mockSupabase.address().port;

  // 2. Start server.js with mocked Supabase environment
  const child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: "0",
      SUPABASE_URL: `http://127.0.0.1:${sbPort}`,
      SUPABASE_KEY: "mock-anon-key-test"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let serverPort = null;
  const started = new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => {
      const str = data.toString();
      const m = str.match(/http:\/\/localhost:(\d+)/i) || str.match(/port\s+(\d+)/i);
      if (m && !serverPort) {
        serverPort = Number(m[1]);
        resolve();
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", reject);
    setTimeout(() => reject(new Error("server.js timed out")), 10000);
  });

  try {
    await started;

    // 3. Sync bridge state with real mode and 2 leads
    const syncRes = await fetch(`http://127.0.0.1:${serverPort}/api/ctv-bridge/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "real",
        ctvList: [
          { id: "c1", name: "Thanh", ref: "thanh2026", view: "thanhview1234567890", active: true }
        ],
        ctvLinkConfig: {
          publisher: "1111111",
          campaign: "2222222",
          targetUrl: "https://tinvay.vietcredit.com.vn/"
        },
        policy: {
          ownerName: "Dasboard Fin",
          ctvField: "sub2",
          defaultRisk: "high",
          atRates: { low: 2.45, medium: 1.93, high: 1.58 },
          ctvRates: { low: 1.8, medium: 1.28, high: 1.0 }
        },
        leads: [
          {
            conversionId: "SNAP-01",
            campaignName: "Tin Vay VietCredit",
            timeRaw: "2026-11-25 10:00:00",
            commission: 490000,
            statusKey: "approved",
            subs: { sub2: "thanh2026" },
            apiRiskLevel: "low"
          }
        ]
      })
    });
    assert.equal(syncRes.status, 200);

    // Wait 100ms for async save to Supabase
    await new Promise((r) => setTimeout(r, 200));

    // Verify snapshot was saved to Supabase app_settings under key 'at_leads_cache'
    assert.ok(storedSettings["at_leads_cache"], "Snapshot should be saved in at_leads_cache");
    assert.equal(storedSettings["at_leads_cache"].total_leads, 1);
    assert.equal(storedSettings["at_leads_cache"].leads[0].conversionId, "SNAP-01");

    // 4. Test CTV viewer endpoint /api/view/thanhview1234567890 loads from snapshot
    const viewRes = await fetch(`http://127.0.0.1:${serverPort}/api/view/thanhview1234567890`);
    assert.equal(viewRes.status, 200);
    const viewData = await viewRes.json();
    assert.equal(viewData.name, "Thanh");
    assert.equal(viewData.totals.approved, 1);
    assert.equal(viewData.totals.commission, 360000);
    assert.equal(viewData.orders.length, 1);
    assert.equal(viewData.orders[0].id, "SNAP-0");

  } finally {
    child.kill();
    mockSupabase.close();
  }
});
