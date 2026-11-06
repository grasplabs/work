/**
 * Checks that core's shipped bundle, minified, still names its classes and
 * functions as the source does (Wrangler's `keep_names`, on in
 * apps/core/wrangler.jsonc): core reads class names at run time
 * (apps/core/src/staff-audit.ts names a staff audit entry's surface after
 * its target's class), and so do its libraries. A bundle that renamed them
 * would change what they record, silently. Run by the on-prem smoke run
 * (workerd-smoke.ts) on the bundle it serves.
 *
 * `workerd test` loads the bundle in a worker of its own, whose test fails
 * naming every class or function core exports under a name other than its
 * own: minifying without `keep_names` renames them all.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const testModule = "bundle-names.test.js";

const test = `import * as core from "./index.js";

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
 * Runs the check on the dry-run bundle in `out`, whose modules are
 * `modules` (capnp module entries, `index.js` among them). Throws when a
 * name is lost.
 */
export const checkBundleNames = (
  out: string,
  modules: readonly string[]
): void => {
  writeFileSync(path.join(out, testModule), test);
  const config = path.join(out, "bundle-names.capnp");
  writeFileSync(
    config,
    `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "bundle-names", worker = .bundleNames)],
);

const bundleNames :Workerd.Worker = (
  modules = [(name = "${testModule}", esModule = embed "${testModule}"), ${modules.join(", ")}],
  compatibilityDate = "2026-09-15",
);
`
  );
  execFileSync("workerd", ["test", config], { stdio: "inherit" });
};
