// Throwaway measurement of the frame and pages: node measure.cjs <label>
// Reload: for each route, a fresh tab loads it once (HTTP cache warm), then
// reloads it 3 times; per reload: FCP, frame (sidebar + card + chat bar) on
// screen, page's first content, page ready (no skeleton / aria-busy).
// Navigation: from each sidebar page, a click on each other sidebar link;
// time from the press to the row current, the new page's first content and
// ready, and whether the frame blinked (sidebar removed) or the card emptied.
const { chromium } = require("playwright");
const fs = require("node:fs");

const base = "http://localhost:5173";
const label = process.argv[2] ?? "run";
const appHref = process.env.APP ?? "/apps/dba97250-22d3-4b98-b783-010a0dfa0dfa";
const routes = ["/", "/inbox", "/workflows", "/apps", appHref, "/brain", "/agents", "/integrations", "/settings/members"];
const navs = ["/", "/brain", "/apps", "/workflows", "/agents", "/integrations"];

// Runs in the page from its first byte: stamps when each thing first shows.
const probe = () => {
  const t = (window.__t = {});
  window.__events = [];
  const stamp = (k) => {
    if (t[k] === undefined) t[k] = performance.now();
  };
  const W = window.WebSocket;
  window.WebSocket = class extends W {
    constructor(...a) {
      super(...a);
      stamp("wsNew");
      this.addEventListener("open", () => stamp("wsOpen"));
      this.addEventListener("message", () => stamp("wsFirstMsg"));
    }
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (/messages|\.po/.test(e.name)) t.catalog ??= e.responseEnd;
      if (/assets\/index-/.test(e.name)) t.entryJs ??= e.responseEnd;
    }
  }).observe({ type: "resource", buffered: true });
  const check = () => {
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    const card = document.querySelector('[data-slot="app-shell-card"]');
    const page = document.querySelector('[data-slot="app-shell-page"]');
    const dock = document.querySelector('[data-slot="app-shell-dock"], [data-slot="composer"]');
    if (document.body && document.body.innerText.trim() !== "") stamp("anyText");
    if (document.querySelector("[data-slot=spinner], [role=progressbar]")) stamp("spinner");
    if (sidebar && card) stamp("frame");
    if (sidebar && card && dock) stamp("frameDock");
    if (page && page.children.length > 0) {
      stamp("pageFirst");
      const busy = page.querySelector('[data-slot="skeleton"], [aria-busy="true"]');
      if (busy) stamp("skeleton");
      if (!busy && page.innerText.trim() !== "") stamp("pageReady");
    }
    const w = window.__watch;
    if (w) {
      const now = performance.now();
      if (!sidebar) w.sidebarGone = true;
      if (page && page.innerText.trim() === "" && !page.querySelector('[data-slot="skeleton"]')) w.cardEmpty = true;
      if (!page) w.pageGone = true;
      const link = document.querySelector(`[data-slot="sidebar"] a[href="${w.to}"]`);
      if (w.current === undefined && link && (link.getAttribute("aria-current") === "page" || link.hasAttribute("data-active") || link.getAttribute("data-current") === "true")) w.current = now - w.at;
      const pathOk = location.pathname === w.to;
      if (pathOk && w.url === undefined) w.url = now - w.at;
      const fresh = page && (page.innerText !== w.oldText || page.querySelector('[data-slot="skeleton"]'));
      if (pathOk && fresh && page.children.length > 0) {
        if (w.first === undefined) w.first = now - w.at;
        const busy = page.querySelector('[data-slot="skeleton"], [aria-busy="true"]');
        if (busy && w.skeleton === undefined) w.skeleton = now - w.at;
        if (!busy && page.innerText.trim() !== "" && w.ready === undefined) w.ready = now - w.at;
      }
    }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const raf = () => {
    check();
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
};

const round2 = (n) => (n === undefined ? "-" : Math.round(n));
const round = (n) => (n === undefined ? "-" : Math.round(n));

const reloadOnce = async (page, route, first) => {
  if (first) await page.goto(base + route, { waitUntil: "load" });
  else await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__t?.pageReady !== undefined, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  return await page.evaluate(() => {
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
    const nav = performance.getEntriesByType("navigation")[0];
    return { ...window.__t, fcp, dcl: nav?.domContentLoadedEventEnd, url: location.pathname };
  });
};

const navigate = async (page, from, to) => {
  await page.goto(base + from, { waitUntil: "load" });
  await page.waitForFunction(() => window.__t?.pageReady !== undefined, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const link = page.locator(`[data-slot="sidebar"] a[href="${to}"]`).first();
  if ((await link.count()) === 0) return null;
  await link.hover();
  await page.waitForTimeout(150); // a person's pointer rests before the press
  await page.evaluate((to) => {
    window.__watch = { to, at: 0, oldText: document.querySelector('[data-slot="app-shell-page"]')?.innerText };
  }, to);
  // Stamp the press in the page, at pointerdown, as a person's would be.
  await page.evaluate(() => {
    addEventListener("pointerdown", () => (window.__watch.at = performance.now()), { once: true, capture: true });
  });
  await link.click();
  await page.waitForFunction(() => window.__watch?.ready !== undefined, null, { timeout: 15000 }).catch(() => {});
  return await page.evaluate(() => window.__watch);
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: "/tmp/claude-0/m/state.json" });
  await ctx.addInitScript(probe);
  const slow = process.env.SLOW === "1";
  const openPage = async () => {
    const pg = await ctx.newPage();
    if (!slow) return pg;
    const cdp = await ctx.newCDPSession(pg);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: 1.5e6, uploadThroughput: 750e3 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    return pg;
  };
  const out = { label, reload: {}, nav: [] };
  for (const route of process.env.SKIP_RELOAD ? [] : routes) {
    const page = await openPage();
    const runs = [];
    await reloadOnce(page, route, true);
    for (let i = 0; i < 3; i++) runs.push(await reloadOnce(page, route, false));
    const med = (k) => runs.map((r) => r[k]).filter((x) => x !== undefined).sort((a, b) => a - b)[1];
    out.reload[route] = Object.fromEntries(["entryJs", "catalog", "wsNew", "wsOpen", "wsFirstMsg", "fcp", "anyText", "spinner", "frame", "frameDock", "pageFirst", "skeleton", "pageReady"].map((k) => [k, round(med(k))]));
    out.reload[route].landed = runs[0].url;
    await page.close();
  }
  console.log("RELOAD (median of 3, ms from navigation start)");
  console.table(out.reload);
  const page = await openPage();
  for (const from of process.env.SKIP_MATRIX ? [] : navs) {
    for (const to of navs) {
      if (from === to) continue;
      const w = await navigate(page, from, to);
      if (w === null) continue;
      out.nav.push({ from, to, current: round(w.current), url: round(w.url), first: round(w.first), skeleton: round(w.skeleton), ready: round(w.ready), blink: !!w.sidebarGone, cardEmpty: !!w.cardEmpty });
    }
  }
  // In one tab, no reloads: each page twice, the second visit after others.
  const order0 = ["/brain", "/", "/apps", "/workflows", "/agents", "/integrations"];
  const order = order0; const chain = process.env.SKIP_CHAIN ? [] : [...order, "/", ...order, "/"];
  await page.goto(base + "/", { waitUntil: "load" });
  await page.waitForTimeout(2000);
  let visitNo = 1;
  for (const to of chain) {
    const link = page.locator(`[data-slot="sidebar"] a[href="${to}"]`).first();
    await link.hover({ timeout: 5000 }).catch(async () => { await page.screenshot({ path: "/tmp/claude-0/m/chain-fail.png" }); throw new Error("no link " + to + " at " + page.url()); });
    await page.waitForTimeout(150);
    await page.evaluate((to) => {
      window.__watch = { to, at: 0, oldText: document.querySelector('[data-slot="app-shell-page"]')?.innerText };
      addEventListener("pointerdown", () => (window.__watch.at = performance.now()), { once: true, capture: true });
    }, to);
    await link.click();
    await page.waitForFunction(() => window.__watch?.ready !== undefined, null, { timeout: 15000 }).catch(() => {});
    const w = await page.evaluate(() => window.__watch);
    out.chain ??= [];
    out.chain.push({ visit: visitNo, to, first: round2(w.first), skeleton: round2(w.skeleton), ready: round2(w.ready), blink: !!w.sidebarGone });
    if (to === "/") visitNo++;
    if (process.env.SHOTS) await page.screenshot({ path: `/tmp/claude-0/m/chain-${out.chain.length}.png` });
    await page.waitForTimeout(800);
  }
  console.log("SAME TAB, FIRST AND SECOND VISIT (ms from the press)");
  console.table(out.chain);
  console.log("NAVIGATION (ms from the press)");
  console.table(out.nav);
  fs.writeFileSync(`/tmp/claude-0/m/${label}.json`, JSON.stringify(out, null, 2));
  await browser.close();
})();
