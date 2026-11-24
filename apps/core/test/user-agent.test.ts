import { describe, expect, it } from "vite-plus/test";

import { deviceOf } from "../src/user-agent.ts";

// What a session signed in on, as Settings → Security names it: the
// browsers people use, each telling itself apart from the ones whose
// marks it also carries, and nothing of what Grasp doesn't know.

describe("a session's device", () => {
  it.each([
    {
      agent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      device: { browser: "Chrome", system: "macOS", mobile: false },
    },
    {
      agent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      device: { browser: "Edge", system: "Windows", mobile: false },
    },
    {
      agent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      device: { browser: "Safari", system: "iPhone", mobile: true },
    },
    {
      agent:
        "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1",
      device: { browser: "Chrome", system: "iPad", mobile: true },
    },
    {
      agent:
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      device: { browser: "Chrome", system: "Android", mobile: true },
    },
    {
      agent:
        "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
      device: { browser: "Samsung Internet", system: "Android", mobile: true },
    },
    {
      agent:
        "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      device: { browser: "Firefox", system: "Linux", mobile: false },
    },
    {
      agent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      device: { browser: "Safari", system: "macOS", mobile: false },
    },
    {
      agent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
      device: { browser: "Opera", system: "Windows", mobile: false },
    },
    {
      agent:
        "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      device: { browser: "Chrome", system: "ChromeOS", mobile: false },
    },
  ])("names $device.browser on $device.system", ({ agent, device }) => {
    expect(deviceOf(agent)).toStrictEqual(device);
  });

  it("names nothing it doesn't know, nor anything of what was sent", () => {
    expect(
      [null, "", "curl/8.5.0", "<script>alert(1)</script>"].map(deviceOf)
    ).toStrictEqual(
      Array.from({ length: 4 }, () => ({
        browser: null,
        system: null,
        mobile: false,
      }))
    );
  });
});
