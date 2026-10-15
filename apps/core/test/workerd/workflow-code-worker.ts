import {
  appModuleName,
  kitModuleName,
  workflowPaths,
} from "@grasp-os/compiler";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";

import {
  codesFailure,
  isolateCall,
  testOutcomeOf,
} from "../../src/workflows/code.ts";

// A workflow's metadata, tests and dry runs on the on-prem sandbox
// (scripts/workerd-sandbox-workflow-code.test.ts): the same call core makes
// of each (workflows/code.ts), with `SANDBOX_HOST` bound to the sandbox
// supervisor as on-prem binds it, of code written as the SDK's would be.

interface StandInEnv {
  LOADER: WorkerLoader;
  RUNTIME_PROFILE: string;
  SANDBOX_HOST: Fetcher;
}

/** A module whose `Metadata.read` does `body`. */
const moduleOf = (
  body: string
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
export class Metadata extends WorkerEntrypoint { async read() { ${body} } }`;

const cases: Record<string, string> = {
  // AsyncLocalStorage, as a run's bindings use it: the sandbox host's
  // compatibility date has it, as core's own has.
  reads:
    "const store = new AsyncLocalStorage(); return store.run(7, () => ({ ok: true, value: { params: [], triggers: [], stored: store.getStore() } }));",
  busy: "for (;;) {}",
  doesntLoad: "",
};

/** What a workflow's tests do, as the SDK's test harness would run them. */
const harnesses: Record<string, string> = {
  // Past V8's own heap limit, which ends its process: its own doing.
  exhausts:
    "export const runWorkflowTests = async () => { const held = []; for (;;) held.push(new Array(1e5).fill(1)); };",
  // Never ends: on a process killed from outside, a crash.
  spins: "export const runWorkflowTests = async () => { for (;;) {} };",
  fails:
    'export const runWorkflowTests = async () => ({ passed: false, results: [{ name: "t", failures: ["no"] }] });',
};

/** How workflow `notes`'s tests went with `harness`, as core reads them. */
const testsWith = async (env: StandInEnv, harness: string) => {
  const id = workflowIdSchema.parse("notes");
  return await testOutcomeOf(
    env,
    appIdSchema.parse("app-stand-in"),
    id,
    {
      [kitModuleName("@grasp-os/sdk/testing")]: harness,
      [appModuleName(workflowPaths(id).tests)]:
        'export default { definition: { metadata: { id: "notes" } } };',
    },
    "{}"
  );
};

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/tests") {
      const harness = harnesses[searchParams.get("case") ?? ""];
      return harness === undefined
        ? new Response("no such case", { status: 404 })
        : Response.json(await testsWith(env, harness));
    }
    if (pathname !== "/run") {
      return new Response("core answers");
    }
    const name = searchParams.get("case") ?? "";
    const body = cases[name];
    if (body === undefined) {
      return new Response("no such case", { status: 404 });
    }
    const started = Date.now();
    try {
      const value = await isolateCall(env, {
        key: null,
        owner: "app-stand-in",
        mainModule: "metadata.js",
        modules: async () =>
          await Promise.resolve({
            "metadata.js":
              name === "doesntLoad"
                ? 'throw new Error("a definition the SDK refuses");'
                : moduleOf(body),
          }),
        entrypoint: "Metadata",
        method: "read",
        args: [],
      });
      return Response.json({ ok: true, value, ms: Date.now() - started });
    } catch (error) {
      return Response.json({
        ok: false,
        codes: codesFailure(error) ?? null,
        message: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started,
      });
    }
  },
} satisfies ExportedHandler<StandInEnv>;
