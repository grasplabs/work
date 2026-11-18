// Filmstrip of a reload and navigations: CDP screencast frames with timestamps.
const { chromium } = require("playwright");
const fs = require("node:fs");
const label = process.argv[2];
const route = process.argv[3] ?? "/apps";
const slow = process.env.SLOW === "1";
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, storageState: "/tmp/claude-0/m/state.json" });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  if (slow) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: 1.5e6, uploadThroughput: 750e3 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  await p.goto("http://localhost:5173" + route, { waitUntil: "networkidle" });
  await p.waitForTimeout(1000);
  const dir = `/tmp/claude-0/m/film-${label}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    frames.push({ t: f.metadata.timestamp, data: f.data });
    await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 720, maxHeight: 450, everyNthFrame: 1 });
  await p.waitForTimeout(300);
  const t0 = Date.now() / 1000;
  await p.reload();
  await p.waitForTimeout(slow ? 9000 : 2500);
  await cdp.send("Page.stopScreencast");
  for (const f of frames) {
    const ms = Math.round((f.t - t0) * 1000);
    fs.writeFileSync(`${dir}/${String(Math.max(ms, 0)).padStart(5, "0")}.jpg`, Buffer.from(f.data, "base64"));
  }
  console.log(fs.readdirSync(dir).join(" "));
  await b.close();
})();
