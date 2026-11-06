/**
 * The lab's connect config (dev.ts): Wrangler reads `.dev.vars` from the
 * folder of the config it is given, so connect's local secrets must stand
 * beside the lab's copy of its config, or connect can't keep a key.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { writeLabConnectConfig } from "./dev.ts";

describe("the lab's connect config", () => {
  it("stands beside connect's local secrets, so connect can seal a provider's key", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "lab-dev-"));
    const devVars = path.join(folder, "connect.dev.vars");
    writeFileSync(
      devVars,
      "CAPABILITY_SIGNING_KEY=made-up\nTOKEN_ENCRYPTION_KEY=made-up\n"
    );
    const target = path.join(folder, "out/connect/wrangler.json");
    writeLabConnectConfig(target, "http://localhost:8799", devVars);
    expect(
      readFileSync(path.join(folder, "out/connect/.dev.vars"), "utf-8")
    ).toContain("TOKEN_ENCRYPTION_KEY=made-up");
    expect(readFileSync(target, "utf-8")).toContain(
      '"AI_PROVIDER_ORIGIN": "http://localhost:8799"'
    );
  });
});
