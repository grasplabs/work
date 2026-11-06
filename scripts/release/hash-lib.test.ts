import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assetContentKey } from "@grasp-os/shared/release";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { collectAssets, collectModules } from "./hash-lib.ts";

describe("release hashing", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "grasp-os-hash-test-"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("keys an asset by its contents and extension", async () => {
    const html = Buffer.from("<html></html>");
    await expect(assetContentKey(html, "dir/index.html")).resolves.toBe(
      "d4c01ae8630098078a961cef6cb9e3b3"
    );
    await expect(assetContentKey(html, "index.txt")).resolves.not.toBe(
      await assetContentKey(html, "index.html")
    );
  });

  it("fails on a bundled file it has no module type for", async () => {
    writeFileSync(path.join(dir, "index.js"), "export default {};\n");
    writeFileSync(path.join(dir, "mystery.dat"), "?");
    await expect(collectModules(dir, { sourceMaps: true })).rejects.toThrow(
      /mystery\.dat/u
    );
  });

  it("ships a source map without the sources it embeds, unless it's off", async () => {
    writeFileSync(path.join(dir, "index.js"), "export default {};\n");
    const map = {
      version: 3,
      sources: ["../src/index.ts"],
      sourcesContent: ["export default {};\n"],
      names: [],
      mappings: "AAAA",
    };
    writeFileSync(path.join(dir, "index.js.map"), JSON.stringify(map));

    const { modules } = await collectModules(dir, { sourceMaps: true });
    const shipped = modules.find(({ name }) => name === "index.js.map");
    expect(shipped?.type).toBe("sourcemap");
    const { sourcesContent: _sources, ...mappings } = map;
    expect(JSON.parse(shipped?.bytes.toString("utf-8") ?? "")).toStrictEqual(
      mappings
    );
    expect(shipped?.size).toBe(shipped?.bytes.length);

    const without = await collectModules(dir, { sourceMaps: false });
    expect(without.modules.map(({ name }) => name)).toStrictEqual(["index.js"]);
  });

  it("fails without exactly one ES module", async () => {
    writeFileSync(path.join(dir, "a.js"), "export default {};\n");
    writeFileSync(path.join(dir, "b.js"), "export default {};\n");
    await expect(collectModules(dir, { sourceMaps: true })).rejects.toThrow(
      /a\.js, b\.js/u
    );
  });

  it("refuses asset files that Wrangler reads as configuration", async () => {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "_headers"), "/*\n  X-Frame-Options: DENY\n");
    await expect(collectAssets(dir)).rejects.toThrow(/_headers/u);
  });
});
