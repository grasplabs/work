/**
 * Checks that minifying core changes nothing it does, on bundles Wrangler
 * minifies as it minifies core (`minify` and `keep_names`, read from
 * apps/core/wrangler.jsonc), run by `workerd test` on core's own
 * compatibility date and flags. The on-prem smoke run (workerd-smoke.ts)
 * runs it on the bundle it serves.
 *
 * - Names: core reads class names at run time (src/staff-audit.ts names a
 *   staff audit entry's surface after its target's class), and so do its
 *   libraries. A worker imports core's shipped bundle, and its test fails
 *   naming every class or function core exports under a name other than
 *   its own: minifying without `keep_names` renames them all.
 * - A staff view's audit: a minified bundle renames every parameter, so
 *   the names a staff view is audited by come from their source
 *   (apps/core/build-rpc-params.ts). apps/core/minified-staff-audit.ts,
 *   bundled as core is, calls a real target's method and fails unless the
 *   view would be audited under its target's surface with the ID its
 *   parameter is named for.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { coreWranglerConfig } from "./workerd-smoke-config.ts";
import { parseJsonc } from "./wrangler-config-rules.ts";

const coreDir = path.dirname(coreWranglerConfig);

/** What of core's wrangler config its bundle is built and run with. */
const bundling = z
  .looseObject({
    compatibility_date: z.string(),
    compatibility_flags: z.array(z.string()).default([]),
    minify: z.boolean().optional(),
    keep_names: z.boolean().optional(),
    rules: z.array(z.unknown()).optional(),
  })
  .parse(parseJsonc(readFileSync(coreWranglerConfig, "utf-8")));

/**
 * The modules Wrangler writes beside a bundle's index.js in `dir`, as
 * capnp module entries: text (its migrations and skills) and WebAssembly
 * (oxc-parse.wasm, by the name Wrangler gives it), as Wrangler's rules
 * bundle them.
 */
export const bundledModules = (dir: string): string[] =>
  readdirSync(dir).flatMap((file) => {
    if (/(?:\.sql|SKILL\.md)$/u.test(file)) {
      return [`(name = "${file}", text = embed "${file}")`];
    }
    return file.endsWith(".wasm")
      ? [`(name = "${file}", wasm = embed "${file}")`]
      : [];
  });

/** A capnp worker of `modules`, the first its main, on core's date and flags. */
const worker = (modules: readonly string[]): string => `(
  modules = [${modules.join(", ")}],
  compatibilityDate = "${bundling.compatibility_date}",
  compatibilityFlags = ${JSON.stringify(bundling.compatibility_flags)},
)`;

const namesTest = `import * as core from "./index.js";

export default {
  test() {
    const renamed = Object.entries(core)
      .filter(([name, value]) => typeof value === "function" && value.name !== name)
      .map(([name, value]) => \`\${name} (named \${value.name})\`);
    if (renamed.length > 0) {
      throw new Error(\`core's bundle renamed what it exports: \${renamed.join(", ")}\`);
    }
  },
};
`;

/**
 * apps/core/minified-staff-audit.ts bundled into `out`/bundle, by
 * Wrangler, with core's bundling settings, from a config of its own
 * written to `out`.
 */
const bundleStaffAuditCheck = (out: string): void => {
  mkdirSync(out);
  const config = path.join(out, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "grasp-minified-check",
      main: path.join(coreDir, "minified-staff-audit.ts"),
      compatibility_date: bundling.compatibility_date,
      compatibility_flags: bundling.compatibility_flags,
      minify: bundling.minify,
      keep_names: bundling.keep_names,
      rules: bundling.rules,
    })
  );
  execFileSync(
    "wrangler",
    ["deploy", "--dry-run", "--outdir", path.join(out, "bundle"), "-c", config],
    { cwd: coreDir, stdio: "inherit" }
  );
};

/**
 * Runs both checks: the names one on core's dry-run bundle in `out` (the
 * one the smoke run serves), the staff audit one on a bundle of its own,
 * built under `out`. Throws when either fails.
 */
export const checkMinified = (out: string): void => {
  writeFileSync(path.join(out, "names.test.js"), namesTest);
  bundleStaffAuditCheck(path.join(out, "staff-audit-check"));
  const auditDir = path.join(out, "staff-audit-check", "bundle");
  const capnp = path.join(out, "minified-checks.capnp");
  writeFileSync(
    capnp,
    `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "names", worker = .names),
    (name = "staff-audit", worker = .staffAudit),
  ],
);

const names :Workerd.Worker = ${worker([
      `(name = "names.test.js", esModule = embed "names.test.js")`,
      `(name = "index.js", esModule = embed "index.js")`,
      ...bundledModules(out),
    ])};

const staffAudit :Workerd.Worker = ${worker([
      `(name = "index.js", esModule = embed "staff-audit-check/bundle/minified-staff-audit.js")`,
      ...bundledModules(auditDir).map((entry) =>
        entry.replace(/embed "/u, 'embed "staff-audit-check/bundle/')
      ),
    ])};
`
  );
  execFileSync("workerd", ["test", capnp], { stdio: "inherit" });
};
