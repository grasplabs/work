/**
 * Code Mode's run record claims the CPU limit as enforced only where
 * `RUNTIME_PROFILE=cloudflare` (apps/core/src/code-mode.ts). These read the
 * real configs: local dev and the on-prem smoke run on plain workerd must
 * say `workerd`, and core's wrangler.jsonc, which dev and tests read too,
 * must say nothing, so no unvouched run claims a limit. Core runs on
 * Cloudflare only as the admin deploys it, which sets `cloudflare`
 * (apps/admin/src/deploy/core-config.ts, `clientRuntimeProfile`). An
 * App's v1 server keeps its tail, its error log's server lines, only where
 * it says `cloudflare` too (apps/core/src/app.ts, GRA-919).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { smokeConfig } from "./workerd-smoke-config.ts";
import { parseJsonc } from "./wrangler-config-rules.ts";

const root = path.join(import.meta.dirname, "..");
const read = (file: string): string =>
  readFileSync(path.join(root, file), "utf-8");

const coreScripts = (): Record<string, string> =>
  z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(JSON.parse(read("apps/core/package.json"))).scripts;

const whitespace = /\s+/u;

/**
 * The `--var NAME:value`s an npm script passes to `wrangler <command>`, by
 * name; undefined when the script never runs that command.
 */
const wranglerVars = (
  script: string,
  command: string
): Record<string, string> | undefined => {
  const step = script
    .split("&&")
    .map((part) => part.trim().split(whitespace))
    .find(
      ([program, subcommand]) =>
        program === "wrangler" && subcommand === command
    );
  if (step === undefined) {
    return undefined;
  }
  const vars: Record<string, string> = {};
  for (const [index, token] of step.entries()) {
    const value = step[index + 1];
    if (token === "--var" && value !== undefined) {
      const [name = "", ...rest] = value.split(":");
      vars[name] = rest.join(":");
    }
  }
  return vars;
};

describe("the runtime profile each deployment says", () => {
  it("is workerd in local dev", () => {
    const dev = coreScripts().dev ?? "";
    expect(wranglerVars(dev, "dev")?.RUNTIME_PROFILE).toBe("workerd");
  });

  it("is workerd in the on-prem smoke run on plain workerd", () => {
    const config = smokeConfig({
      port: 8790,
      sandboxSocket: "/run/grasp-sandbox/supervisor.sock",
      routerSecret: "s",
      modules: [],
      storage: "/tmp/storage",
    });
    const profiles = [
      ...config.matchAll(
        /name = "RUNTIME_PROFILE", text = "(?<value>[^"]*)"/gu
      ),
    ].map((match) => match.groups?.value);
    expect(profiles).toStrictEqual(["workerd"]);
  });

  it("lets only local dev and tests run App code in core without a sandbox", () => {
    const { dev = "" } = coreScripts();
    const { vars } = z
      .object({ vars: z.record(z.string(), z.unknown()).default({}) })
      .parse(parseJsonc(read("apps/core/wrangler.jsonc")));
    expect({
      dev: wranglerVars(dev, "dev")?.SANDBOX_IN_PROCESS,
      wrangler: vars.SANDBOX_IN_PROCESS,
      admin: read("apps/admin/src/deploy/core-config.ts").includes(
        "SANDBOX_IN_PROCESS"
      ),
      tests: read("apps/core/vite.config.ts").includes(
        'SANDBOX_IN_PROCESS: "unbounded"'
      ),
    }).toStrictEqual({
      dev: "unbounded",
      wrangler: undefined,
      admin: false,
      tests: true,
    });
  });

  it("is never set in core's wrangler.jsonc, which dev and tests read", () => {
    const { vars } = z
      .object({ vars: z.record(z.string(), z.unknown()).default({}) })
      .parse(parseJsonc(read("apps/core/wrangler.jsonc")));
    expect(vars.RUNTIME_PROFILE).toBeUndefined();
  });
});
