// Frames of three navigations in one tab: press at t=0, CDP screencast.
const { chromium } = require("playwright");
const fs = require("node:fs");
const label = process.argv[2];
const steps = [["/apps", "/workflows"], ["/workflows", "/integrations"], ["/integrations", "/brain"]];
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, storageState: "/tmp/claude-0/m/state.json" });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await p.goto("http://localhost:5173" + steps[0][0], { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  for (const [from, to] of steps) {
    const dir = `/tmp/claude-0/m/film-${label}-${to.slice(1)}`;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const frames = [];
    const on = async (f) => {
      frames.push({ t: f.metadata.timestamp, data: f.data });
      await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    };
    cdp.on("Page.screencastFrame", on);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 720, maxHeight: 450 });
    const link = p.locator(`[data-slot="sidebar"] a[href="${to}"]`).first();
    await link.hover();
    await p.waitForTimeout(400);
    await p.evaluate(() => addEventListener("pointerdown", () => (window.__press = performance.timeOrigin + performance.now()), { once: true, capture: true }));
    await link.click();
    const t0 = (await p.evaluate(() => window.__press)) / 1000;
    await p.waitForTimeout(1600);
    await cdp.send("Page.stopScreencast");
    cdp.off("Page.screencastFrame", on);
    for (const f of frames) {
      const ms = Math.round((f.t - t0) * 1000);
      fs.writeFileSync(`${dir}/${ms < 0 ? "-" : ""}${String(Math.abs(ms)).padStart(5, "0")}.jpg`, Buffer.from(f.data, "base64"));
    }
    console.log(to, fs.readdirSync(dir).join(" "));
    await p.waitForTimeout(500);
  }
  await b.close();
})();
