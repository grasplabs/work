/**
 * Code Mode's run record claims the CPU limit as enforced only where
 * `RUNTIME_PROFILE=cloudflare` (apps/core/src/code-mode.ts). These read the
 * real configs: staging's deploy must say `cloudflare`, so its records carry
 * the right evidence; local dev and the on-prem smoke run on plain workerd
 * must say `workerd`; and core's wrangler.jsonc, which dev and tests read
 * too, must say nothing, so no unvouched run claims a limit. The console's
 * client deploys are covered by its deploy test (apps/console/test).
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
  it("is cloudflare on staging, whose CI deploy runs core's deploy script", () => {
    const deploy = coreScripts().deploy ?? "";
    expect({
      vars: wranglerVars(deploy, "deploy")?.RUNTIME_PROFILE,
      ci: read(".github/workflows/ci.yml").includes(
        "vp run --filter @grasp-os/core deploy"
      ),
    }).toStrictEqual({ vars: "cloudflare", ci: true });
  });

  it("is workerd in local dev", () => {
    const dev = coreScripts().dev ?? "";
    expect(wranglerVars(dev, "dev")?.RUNTIME_PROFILE).toBe("workerd");
  });

  it("is workerd in the on-prem smoke run on plain workerd", () => {
    const config = smokeConfig({
      port: 8790,
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

  it("is never set in core's wrangler.jsonc, which dev and tests read", () => {
    const { vars } = z
      .object({ vars: z.record(z.string(), z.unknown()).default({}) })
      .parse(parseJsonc(read("apps/core/wrangler.jsonc")));
    expect(vars.RUNTIME_PROFILE).toBeUndefined();
  });
});
