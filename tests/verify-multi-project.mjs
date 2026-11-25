import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("Multi-project link isolation: VietCredit and TNEX are cleanly separated, synchronized, and tracked per CTV ref", async () => {
  const child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      SUPABASE_URL: "",
      SUPABASE_KEY: "",
      PORT: "0"
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

    const testRef = "hoang" + Math.floor(Math.random() * 8999 + 1000);
    const testView = "view" + Math.random().toString(36).slice(2, 12) + "abcdef12";

    // 1. Sync bridge state with BOTH VietCredit and TNEX configured
    const syncRes = await fetch(`http://127.0.0.1:${serverPort}/api/ctv-bridge/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "demo",
        ctvList: [
          { id: "c1", name: "Hoàng", ref: testRef, view: testView, active: true }
        ],
        ctvLinkConfig: {
          trackClicks: true,
          viewBase: `http://127.0.0.1:${serverPort}`,
          defaultProject: "vietcredit",
          projects: {
            vietcredit: {
              id: "vietcredit",
              name: "VietCredit - Công ty Tài chính Cổ phần Tín Việt",
              publisher: "4608706208340350795",
              campaign: "6997817930567730686",
              targetUrl: "https://tinvay.vietcredit.com.vn/",
              enabled: true
            },
            tnex: {
              id: "tnex",
              name: "TNEX - Ngân hàng số Hàng Hải (MSB)",
              publisher: "4608706208340350795",
              campaign: "54930219483012948",
              targetUrl: "https://www.tnex.com.vn/",
              enabled: true
            }
          }
        },
        policy: {
          ownerName: "Dasboard Fin",
          ctvField: "sub2",
          defaultRisk: "high"
        },
        leads: []
      })
    });
    assert.equal(syncRes.status, 200);

    // 2. Fetch CTV view API - verify project_links has both vietcredit and tnex
    const viewRes = await fetch(`http://127.0.0.1:${serverPort}/api/view/${testView}`);
    assert.equal(viewRes.status, 200);
    const viewData = await viewRes.json();
    assert.equal(viewData.name, "Hoàng");
    assert.ok(viewData.project_links, "project_links must exist");

    const vcLink = viewData.project_links.vietcredit;
    const tnexLink = viewData.project_links.tnex;
    assert.ok(vcLink, "VietCredit link must be present");
    assert.ok(tnexLink, "TNEX link must be present");
    assert.notEqual(vcLink, tnexLink, "VietCredit and TNEX links must be distinct!");

    assert.equal(vcLink, `http://127.0.0.1:${serverPort}/l/${testRef}`);
    assert.equal(tnexLink, `http://127.0.0.1:${serverPort}/l/${testRef}/tnex`);

    // 3. Test redirection: VietCredit link redirects to VietCredit deep link
    const vcRedirRes = await fetch(vcLink, { redirect: "manual" });
    assert.equal(vcRedirRes.status, 302);
    const vcTarget = vcRedirRes.headers.get("location");
    assert.ok(vcTarget.includes("6997817930567730686"), "VietCredit target must contain VietCredit campaign ID");
    assert.ok(vcTarget.includes(`sub2=${testRef}`), "VietCredit target must contain CTV sub2 ref");
    assert.equal(vcTarget.includes("54930219483012948"), false, "VietCredit target must NOT contain TNEX campaign ID!");

    // 4. Test redirection: TNEX link redirects to TNEX deep link
    const tnexRedirRes = await fetch(tnexLink, { redirect: "manual" });
    assert.equal(tnexRedirRes.status, 302);
    const tnexTarget = tnexRedirRes.headers.get("location");
    assert.ok(tnexTarget.includes("54930219483012948"), "TNEX target must contain TNEX campaign ID");
    assert.ok(tnexTarget.includes(`sub2=${testRef}`), "TNEX target must contain CTV sub2 ref");
    assert.equal(tnexTarget.includes("6997817930567730686"), false, "TNEX target must NOT contain VietCredit campaign ID!");

    // 5. Test click tracking: Both clicks were counted under testRef
    const clicksRes = await fetch(`http://127.0.0.1:${serverPort}/api/ctv-clicks`);
    assert.equal(clicksRes.status, 200);
    const clicksData = await clicksRes.json();
    assert.equal(clicksData.clicksByRef[testRef].total, 2);

    // 6. Test TNEX persistence guard: Even if a subsequent sync sends empty projects ({}), TNEX stays intact
    const partialSyncRes = await fetch(`http://127.0.0.1:${serverPort}/api/ctv-bridge/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "demo",
        ctvList: [{ id: "c1", name: "Hoàng", ref: testRef, view: testView, active: true }],
        ctvLinkConfig: {
          publisher: "4608706208340350795",
          campaign: "6997817930567730686",
          targetUrl: "https://tinvay.vietcredit.com.vn/",
          viewBase: `http://127.0.0.1:${serverPort}`,
          salesLinkMode: "short_auto",
          trackClicks: true,
          projects: {}
        }
      })
    });
    assert.equal(partialSyncRes.status, 200);

    const viewAfterPartialRes = await fetch(`http://127.0.0.1:${serverPort}/api/view/${testView}`);
    assert.equal(viewAfterPartialRes.status, 200);
    const viewAfterPartial = await viewAfterPartialRes.json();
    assert.equal(viewAfterPartial.project_links.tnex, tnexLink, "TNEX project link must survive partial/empty projects sync!");

    const tnexRedirAfterRes = await fetch(tnexLink, { redirect: "manual" });
    assert.equal(tnexRedirAfterRes.status, 302);
    assert.ok(tnexRedirAfterRes.headers.get("location").includes("54930219483012948"), "TNEX redirect must still resolve TNEX campaign!");

  } finally {
    child.kill();
  }
});
