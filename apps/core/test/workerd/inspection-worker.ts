import { appModuleName, kitModuleName } from "@grasp-os/compiler";
import { versionErrors } from "@grasp-os/shared/app-releases";

import { inspected } from "../../src/app-releases.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import type { SandboxedEnv } from "../../src/sandboxed.ts";

// A seal's inspection on plain workerd (scripts/workerd-sandbox.test.ts):
// the same `inspected` a seal runs, with `SANDBOX_HOST` bound to the
// sandbox supervisor as on-prem binds it, and no Wrangler or Miniflare.
// Each App below is inspected on request; the test reads how it ended.

/**
 * The SDK's runner as far as an inspection uses it. Everything in the
 * isolate is untrusted, the runner too, so the sandbox can't rely on it.
 */
const runner =
  "export const manifestOfApp = (registered) => JSON.stringify(registered);";

/** Each App's `app.ts`, as its build would leave it. */
const apps: Record<string, string> = {
  good: 'export default { name: "good" };',
  // As in the probe that found the gap: a busy loop inside `manifest()`,
  // through the JSON.stringify the runner calls.
  busyManifest:
    "JSON.stringify = () => { for (;;) {} }; export default { name: 'busy' };",
  busyStartup: "for (;;) {} export default { name: 'busy' };",
  throws:
    "export default { get name() { throw new Error('a broken registration'); } };",
  // Its inspection answers nothing: the App's code replaces the method it's
  // asked through, reaching the inspection module by its name.
  notText: `import * as inspection from "grasp-inspect.js";
queueMicrotask(() => { inspection.Inspect.prototype.manifest = () => undefined; });
export default { name: "nothing" };`,
};

/** How an inspection ended. */
type Outcome =
  | { status: "inspected"; text: string }
  | { status: "refused"; code: string; message: string }
  | { status: "unavailable"; message: string };

const inspect = async (env: SandboxedEnv, app: string): Promise<Outcome> => {
  try {
    const text = await inspected(
      env,
      { [appModuleName("app.ts")]: apps[app] ?? "" },
      { [kitModuleName("@grasp-os/sdk/runner")]: runner }
    );
    return { status: "inspected", text };
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      return { status: "unavailable", message: error.message };
    }
    const code = versionErrors.codeOf(error);
    if (code !== undefined) {
      const details: unknown =
        typeof error === "object" && error !== null && "details" in error
          ? error.details
          : {};
      return { status: "refused", code, message: JSON.stringify(details) };
    }
    throw error;
  }
};

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/inspect") {
      const started = Date.now();
      // As a deployment off Cloudflare that forgot its sandbox.
      const unbound = searchParams.has("unbound");
      const outcome = await inspect(
        unbound ? { ...env, SANDBOX_HOST: undefined } : env,
        searchParams.get("app") ?? ""
      );
      return Response.json({ ...outcome, ms: Date.now() - started });
    }
    return new Response("core answers");
  },
} satisfies ExportedHandler<SandboxedEnv>;
