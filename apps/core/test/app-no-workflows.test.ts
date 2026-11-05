import { appErrors } from "@grasp-os/shared/apps";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { installBuiltinBlueprint } from "../src/app-blueprints.ts";
import {
  builtins,
  fingerprintOf,
  loadBuiltinRelease,
} from "../src/builtins.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { refusal, signedInApi } from "./sign-in.ts";

// An App holds no workflows of its own (GRA-1367). What it reaches is what
// its version declares: each resource in its manifest, bound and approved
// by an admin for that declaration, and each independent workflow it binds
// under an alias, whose every call is a binding of its validated
// definition, approved for that exact version. No code is read to say what
// a version calls, so nothing may run that the review doesn't list.
//
// The attacks, each refused:
// - code under `workflows/` committed into an App, which would run as the
//   App's own workflow with the App's permissions, its calls read from its
//   code rather than listed and approved: every commit refuses it, naming
//   it, and commits nothing (the chat's agent: agent-builds.test.ts);
// - such code in a blueprint, reaching an App created from it, or one
//   updated to its newer code: neither is made, and nothing of it kept.

const idp = mockIdp();

/** A refusal as it reaches the client, with the paths it names. */
const refusedSchema = z.object({
  details: z.object({ issues: z.array(z.string()) }),
});

/** Code that would reach the App's mail binding outside any review. */
const stealing = {
  "workflows/steal.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("steal", { params: {}, input: z.unknown() }, async (step, { env }) =>
  await step.do("send", { description: "Send", sideEffect: true }, async () =>
    await env.MAIL.call("mail.send", { to: "out@example.test", subject: "Data" })
  )
);
`,
};

describe("an App's own workflows", () => {
  it("are refused on every commit, named, with nothing committed, whatever else the commit holds", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Ledger" });
    await release(builder, app, { "AGENTS.md": "# Ledger\n" });

    const refused = await Promise.all([
      refusal(builder.api.apps.files.commit(app, stealing, "Steal")),
      refusal(
        builder.api.apps.files.commit(
          app,
          { "notes.md": "# Notes\n", "workflows/lib/send.ts": "export {};\n" },
          "Helper"
        )
      ),
    ]);
    const versions = await builder.api.apps.versions.list(app);

    expect({
      refused: refused.map((error) => ({
        code: appErrors.codeOf(error),
        issues: refusedSchema.parse(error).details.issues,
      })),
      versions: versions.map(({ version }) => version),
    }).toStrictEqual({
      refused: [
        { code: "app.no_workflows", issues: ["workflows/steal.ts"] },
        { code: "app.no_workflows", issues: ["workflows/lib/send.ts"] },
      ],
      versions: [1],
    });
  });

  it("are refused in a blueprint an App is created from, or updated to, with nothing made", async () => {
    const builder = await signedInApi(idp, "builder");
    const builtinRelease = await loadBuiltinRelease();
    await builtins(env).ensureInstalled(await fingerprintOf(builtinRelease));
    const hello = builtinRelease.blueprints.find(({ id }) => id === "hello");
    if (hello === undefined) {
      throw new Error("The global setup didn't embed the tests' built-in");
    }
    // Made from the release's `hello`, before any workflow code is in it.
    const { app: copy } = await builder.api.apps.blueprints.create("hello", {
      name: "Copy",
    });
    const before = await builder.api.apps.list();
    await installBuiltinBlueprint(env, {
      ...hello,
      files: { ...hello.files, ...stealing },
    });
    try {
      const created = await refusal(
        builder.api.apps.blueprints.create("hello", { name: "Stolen" })
      );
      const offered = await builder.api.apps.blueprints.update(copy.id);
      if (offered === null) {
        throw new Error("No update was offered");
      }
      const updated = await refusal(
        builder.api.apps.blueprints.acceptUpdate(copy.id, {
          to: offered.to,
          over: offered.over,
        })
      );
      const after = await builder.api.apps.list();
      const versions = await builder.api.apps.versions.list(copy.id);
      expect({
        refused: [created, updated].map((error) => ({
          code: appErrors.codeOf(error),
          issues: refusedSchema.parse(error).details.issues,
        })),
        apps: after.length - before.length,
        versions: versions.map(({ version }) => version),
      }).toStrictEqual({
        refused: [
          { code: "app.no_workflows", issues: ["workflows/steal.ts"] },
          { code: "app.no_workflows", issues: ["workflows/steal.ts"] },
        ],
        apps: 0,
        versions: [1],
      });
    } finally {
      await installBuiltinBlueprint(env, hello);
    }
  });
});
