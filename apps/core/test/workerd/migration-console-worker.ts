import { appModuleName, kitModuleName } from "@grasp-os/compiler";

import { transformIsolate } from "../../src/migration-transform.ts";
import { callSandboxed } from "../../src/sandboxed.ts";
import type { SandboxedEnv } from "../../src/sandboxed.ts";

// A migration's transform logging a record's values on the on-prem sandbox
// (scripts/workerd-sandbox-migration-console.test.ts): the isolate core
// runs a batch in (migration-transform.ts, `transformIsolate`), with
// `SANDBOX_HOST` bound to the sandbox supervisor as on-prem binds it, and,
// to show the logs are read at all, an isolate of its own that logs.

/** The value a record holds that no log may carry. */
const recordValue = "record-value-7f3a";

/** What the control isolate logs, which the logs must carry. */
const controlValue = "control-value-91c2";

/**
 * An App whose migration logs each record it gets every way it can: on
 * the console, with a console method it kept as it loaded, through
 * `node:console`, and through a console method it puts back itself.
 */
const app = `import nodeConsole from "node:console";
// Kept as the module loads, to log with later.
const kept = console.log;
export default {
  migrate(rows) {
    for (const row of rows) {
      kept(row.fields.title);
      console.log(row.fields.title);
      console.info(row);
      console.warn(row.fields.title);
      console.error(row.fields.title);
      console.debug(row.fields.title);
      console.trace(row.fields.title);
      nodeConsole.log(row.fields.title);
      console.log = (...args) => console.error(...args);
      console.log(row.fields.title);
    }
    return rows;
  },
};
`;

/** The SDK's runner, standing in: hands the batch to the App's migration. */
const runner = `export const runMigration = (registered, request) => ({
  ok: true,
  rows: registered.migrate(request.rows),
});
`;

/** An isolate that logs `controlValue`, nothing silencing it. */
const control = `import { WorkerEntrypoint } from "cloudflare:workers";
export class Control extends WorkerEntrypoint {
  run() {
    console.log(${JSON.stringify(controlValue)});
    return "logged";
  }
}
`;

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/run") {
      return new Response("core answers");
    }
    const transformed = await callSandboxed(
      env,
      transformIsolate(
        {
          modules: { [appModuleName("app.ts")]: app },
          sdk: { [kitModuleName("@grasp-os/sdk/runner")]: runner },
        },
        {
          name: "derive-category",
          rows: [{ id: "note-1", fields: { title: recordValue } }],
        }
      ),
      "Migrate",
      "run"
    );
    const logged = await callSandboxed(
      env,
      { mainModule: "control.js", modules: { "control.js": control } },
      "Control",
      "run"
    );
    return Response.json({ transformed, logged, recordValue, controlValue });
  },
} satisfies ExportedHandler<SandboxedEnv>;
