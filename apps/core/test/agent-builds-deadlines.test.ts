import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { emptyDraft, readDraft, saveDraft } from "../src/app-drafts.ts";
import {
  endedRefusals,
  idp,
  setUp,
  slowFilesDuring,
} from "./agent-builds-harness.ts";
import {
  codeStep,
  says,
  toolResults,
  toolStep,
  transcript,
} from "./agent-chat.ts";
import { mockIdpWith } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";

// `env.build` in a chat's code: the chat's agent building Apps for its
// person in the App's shared draft, and repairing what its checks report.
// These tests start from the ways it can fail: the agent builds past what
// its person may do (an App they don't build, or any App for someone who
// doesn't build), or not at all for someone who does; a chat that read
// restricted data writes it into code others read; the agent writes a
// workflow into an App, whose calls no admin approves binding by binding;
// the agent's draft and a builder's commits overwrite each other; a draft
// that doesn't pass reaches the App; and a repair loop that never ends.

mockIdpWith(idp);

/** A draft over version 1 at `revision`, as a write read it. */
const over = (revision: number) => ({
  base: 1,
  changes: {},
  definition: null,
  revision,
});

describe("building Apps from a chat", { timeout: 120_000 }, () => {
  it("lands no draft write whose run ran out of time while it was under way, with no grant to revoke", async () => {
    const { chat, existing } = await setUp([]);
    await fakeProvider(
      codeStep(`export default async (self, env) => {
          await env.build.write(${JSON.stringify(existing)}, { "src/routes/late.tsx": "import { createFileRoute } from \\"@tanstack/react-router\\";\\nconst Page = () => null;\\n\\nexport const Route = createFileRoute(\\"/late\\")({ component: Page });\\n" }, { revision: (await env.build.files(${JSON.stringify(existing)})).revision });
        };`),
      says("It ran out of time.")
    );

    // The write is let in at once, then waits on the App's files past its
    // run's end: refused as it commits.
    await slowFilesDuring(chat.stub, async () => {
      await chat.ask("Write it.");
    });

    await vi.waitFor(
      async () => {
        await expect(endedRefusals(chat.chat.id)).resolves.toStrictEqual([
          "build.write",
        ]);
      },
      { timeout: 15_000, interval: 100 }
    );
    await expect(readDraft(env, existing)).resolves.toStrictEqual({
      base: null,
      changes: {},
      definition: null,
      revision: 0,
    });
  });

  it("lands no file write the person stopped while it was under way", async () => {
    const { chat, existing } = await setUp((app) => [
      toolStep("writeFile", {
        app,
        files: {
          "src/routes/late.tsx": `import { createFileRoute } from "@tanstack/react-router";
const Page = () => null;

export const Route = createFileRoute("/late")({ component: Page });
`,
        },
      }),
      says("Never asked."),
    ]);

    // The write is let in at once, then waits on the App's files while the
    // person presses Stop: refused as it commits. The chat shows the
    // question, then the call under way.
    await slowFilesDuring(chat.stub, async () => {
      const reply = chat.ask("Write it.");
      await vi.waitFor(
        async () => {
          await expect(
            transcript(chat.stub, chat.chat.id)
          ).resolves.toHaveLength(2);
        },
        { timeout: 10_000 }
      );
      await chat.stub.cancel(chat.chat.id, chat.personId);
      await expect(reply).resolves.toMatchObject({ outcome: "cancelled" });
    });

    // pi ends the aborted call with its own result; the run's record says
    // how the call itself ended.
    const [written] = await toolResults(chat.stub, chat.chat.id);
    expect([written?.tool, written?.isError, written?.text]).toStrictEqual([
      "writeFile",
      true,
      "Tool writeFile was aborted",
    ]);
    await vi.waitFor(async () => {
      await expect(
        runInDurableObject(chat.stub, (_instance, state) =>
          state.storage.sql
            .exec<{ status: string }>(
              "SELECT status FROM chat_code_runs WHERE chat_id = ?",
              chat.chat.id
            )
            .toArray()
            .map(({ status }) => status)
        )
      ).resolves.toStrictEqual(["cancelled"]);
    });
    // pi's result doesn't wait for the call: the write is refused as it
    // commits, after it.
    await vi.waitFor(
      async () => {
        await expect(endedRefusals(chat.chat.id)).resolves.toStrictEqual([
          "build.write",
        ]);
      },
      { timeout: 15_000, interval: 100 }
    );
    await expect(readDraft(env, existing)).resolves.toStrictEqual({
      base: null,
      changes: {},
      definition: null,
      revision: 0,
    });
  });

  it("lands a draft write only over the revision it read, and keeps its revisions going when its changes are all gone", async () => {
    const { builder, existing } = await setUp([]);
    const writer = {
      by: {
        userId: builder.userId,
        role: "builder" as const,
        teams: [],
        staff: false,
        actor: actorOf({ userId: builder.userId, staff: false }),
      },
      detail: {},
    };
    const written = async (
      revision: number,
      changes: Record<string, string>,
      unchanged: string[] = []
    ) =>
      await saveDraft(
        env,
        existing,
        { ...(await readDraft(env, existing)), ...over(revision) },
        { changes, unchanged },
        writer
      )
        .then(() => "written")
        .catch((error: unknown) => appErrors.codeOf(error));

    const outcomes = [
      await written(0, { "a.md": "a" }),
      // Another write read revision 0 too, and lost.
      await written(0, { "a.md": "b" }),
      // Its only change written back as the base has it: none left.
      await written(1, {}, ["a.md"]),
      // A write that read the draft before a discard lands on nothing.
      await emptyDraft(env, existing, { revision: 2, base: 1, ...writer })
        .then(() => "discarded")
        .catch((error: unknown) => appErrors.codeOf(error)),
      await written(2, { "b.md": "b" }),
      await written(3, { "c.md": "c" }),
    ];

    expect({ outcomes, draft: await readDraft(env, existing) }).toStrictEqual({
      outcomes: [
        "written",
        "app.conflict",
        "written",
        "discarded",
        "app.conflict",
        "written",
      ],
      draft: {
        base: 1,
        changes: { "c.md": "c" },
        definition: null,
        revision: 4,
      },
    });
  });
});
