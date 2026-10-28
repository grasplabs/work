import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callApp } from "../src/app.ts";
import { release, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// An App's v1 server off Cloudflare (these tests run as `RUNTIME_PROFILE=
// workerd`): plain workerd would print a tailed isolate's console to the
// process's logs, the deployment's, so core loads it with no tail there,
// and its console silenced (@grasp-os/shared/quiet-loader, GRA-919). What
// it writes reaches neither those logs nor its error log, which a screen's
// report still reaches. On Cloudflare its tail keeps it (app.ts).

const idp = mockIdp();

/** How long a tail's delivery of what a call wrote may take. */
const deliveryMs = 1000;

/** A v1 server whose `run` writes `value` with `console`, then answers it. */
const serverOf = (
  value: string
): string => `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  async run(): Promise<string> {
    console.log(${JSON.stringify(value)});
    console.error(${JSON.stringify(value)});
    return ${JSON.stringify(value)};
  }
}
`;

describe("an App's v1 server off Cloudflare", () => {
  it("answers, and what it writes with console reaches no error log, where a screen's report does", async () => {
    const builder = await signedInApi(idp, "admin");
    const value = `server-line-${unique()}`;
    const { id } = await builder.api.apps.create({
      name: `Console ${unique()}`,
    });
    const app = appIdSchema.parse(id);
    const version = await release(builder, app, {
      "app/server.ts": serverOf(value),
    });
    await serverBuilt(app, version);

    const answer = await callApp(
      env,
      app,
      { userId: builder.userId, mode: "interactive" },
      "run"
    );
    await builder.api.screens.report(
      app,
      { version, screen: "notes" },
      { kind: "error", message: "screen-report" }
    );
    await scheduler.wait(deliveryMs);
    const { entries } = await builder.api.screens.errors(app);

    expect({
      answer,
      sources: entries.map(({ source }) => source),
      written: JSON.stringify(entries).includes(value),
    }).toStrictEqual({
      answer: value,
      sources: ["screen"],
      written: false,
    });
  });
});
