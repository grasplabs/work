import { chatIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  endedRefusals,
  idp,
  setUp,
  slowFilesDuring,
} from "./agent-builds-harness.ts";
import {
  codeStep,
  says,
  testRunOpening,
  toolResults,
  toolStep,
  transcript,
} from "./agent-chat.ts";
import { mockIdpWith } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";

// `env.build` in a chat's code: the chat's agent building Apps for its
// person in a draft of its own, and repairing what its checks report.
// These tests start from the ways it can fail: the agent builds past what
// its person may do (an App they don't build, or any App for someone who
// doesn't build), or not at all for someone who does; a chat that read
// restricted data writes it into code others read; the agent writes a
// workflow into an App, whose calls no admin approves binding by binding;
// the agent's draft and a builder's commits overwrite each other; a draft
// that doesn't pass reaches the App; and a repair loop that never ends.

mockIdpWith(idp);

describe("building Apps from a chat", { timeout: 120_000 }, () => {
  it("lands no draft write whose run ran out of time while it was under way, with no grant to revoke", async () => {
    const { chat, existing } = await setUp([]);
    await fakeProvider(
      codeStep(`export default async (self, env) => {
          await env.build.write(${JSON.stringify(existing)}, { "src/routes/late.tsx": "import { createFileRoute } from \\"@tanstack/react-router\\";\\nconst Page = () => null;\\n\\nexport const Route = createFileRoute(\\"/late\\")({ component: Page });\\n" });
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
    await expect(
      chat.stub.draft(chatIdSchema.parse(chat.chat.id), existing)
    ).resolves.toStrictEqual({
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
    await expect(
      chat.stub.draft(chatIdSchema.parse(chat.chat.id), existing)
    ).resolves.toStrictEqual({
      base: null,
      changes: {},
      definition: null,
      revision: 0,
    });
  });

  it("commits no proposal whose run ran out of time while it was checked", async () => {
    const { chat, builder, existing, grant } = await setUp([]);
    await fakeProvider(
      codeStep(`export default async (self, env) => {
          await env.build.write(${JSON.stringify(existing)}, { "AGENTS.md": "# Ledger, again\\n" });
        };`),
      says("Written."),
      codeStep(`export default async (self, env) => {
          await env.build.propose(${JSON.stringify(existing)}, "Again");
        };`),
      says("It ran out of time.")
    );
    await grant();
    await chat.ask("Write it.");

    // Checked past its run's end: the commit after the check is refused.
    await slowFilesDuring(chat.stub, async () => {
      await chat.ask("Propose it.");
    });

    await vi.waitFor(
      async () => {
        await expect(endedRefusals(chat.chat.id)).resolves.toStrictEqual([
          "build.propose",
        ]);
      },
      { timeout: 30_000, interval: 200 }
    );
    const listed = await builder.api.apps.list();
    expect(listed.find(({ id }) => id === existing)?.pendingVersion).toBeNull();
  });

  it("commits no proposal whose run ran out of time while it stored the version's files, after its last check", async () => {
    const { chat, builder, existing, grant } = await setUp([]);
    await fakeProvider(
      codeStep(`export default async (self, env) => {
          await env.build.write(${JSON.stringify(existing)}, { "AGENTS.md": "# Ledger, once more\\n" });
        };`),
      says("Written."),
      codeStep(`export default async (self, env) => {
          await env.build.propose(${JSON.stringify(existing)}, "Once more");
        };`),
      says("It ran out of time.")
    );
    await grant();
    await chat.ask("Write it.");

    // Only storing the version's tree is slow: the check and the
    // admission before it pass, and the run ends while the tree is stored.
    await slowFilesDuring(
      chat.stub,
      async () => {
        await chat.ask("Propose it.");
      },
      (method, key) =>
        method === "put" && typeof key === "string" && key.includes("/trees/")
    );

    await vi.waitFor(
      async () => {
        await expect(endedRefusals(chat.chat.id)).resolves.toStrictEqual([
          "build.propose",
        ]);
      },
      { timeout: 30_000, interval: 200 }
    );
    const listed = await builder.api.apps.list();
    expect(listed.find(({ id }) => id === existing)?.pendingVersion).toBeNull();
  });

  it("lands a draft write only over the revision it read", async () => {
    const { chat } = await setUp([]);
    const chatId = chatIdSchema.parse(chat.chat.id);

    const saved = await runInDurableObject(chat.stub, (instance) => {
      const run = instance.openCodeRun(
        chatId,
        crypto.randomUUID(),
        testRunOpening
      );
      return [
        instance.saveDraft(chatId, "app-1", null, { "a.md": "a" }, [], 0, {
          runId: run,
        }),
        // Another write read revision 0 too, and lost.
        instance.saveDraft(chatId, "app-1", null, { "a.md": "b" }, [], 0, {
          runId: run,
        }),
        instance.saveDraft(chatId, "app-1", null, { "b.md": "b" }, [], 1, {
          runId: run,
        }),
        instance.draft(chatId, "app-1"),
      ];
    });

    expect(saved).toStrictEqual([
      true,
      false,
      true,
      {
        base: null,
        changes: { "a.md": "a", "b.md": "b" },
        definition: null,
        revision: 2,
      },
    ]);
  });

  it("keeps a draft's revisions going when its changes are all gone", async () => {
    const { chat } = await setUp([]);
    const chatId = chatIdSchema.parse(chat.chat.id);

    const saved = await runInDurableObject(chat.stub, (instance) => {
      const run = instance.openCodeRun(
        chatId,
        crypto.randomUUID(),
        testRunOpening
      );
      return [
        // A write reads revision 0; meanwhile another creates the draft and
        // writes its only change back as the base has it.
        instance.saveDraft(chatId, "app-1", null, { "a.md": "a" }, [], 0, {
          runId: run,
        }),
        instance.saveDraft(chatId, "app-1", null, {}, ["a.md"], 1, {
          runId: run,
        }),
        instance.draft(chatId, "app-1"),
        // The write that read revision 0 lands on nothing.
        instance.saveDraft(chatId, "app-1", null, { "b.md": "b" }, [], 0, {
          runId: run,
        }),
        // Nor once the draft is dropped, as a proposal drops it.
        instance.saveDraft(chatId, "app-1", null, { "c.md": "c" }, [], 2, {
          runId: run,
        }),
        instance.dropDraft(chatId, "app-1", { revision: 3 }),
        instance.saveDraft(chatId, "app-1", null, { "d.md": "d" }, [], 0, {
          runId: run,
        }),
        instance.saveDraft(chatId, "app-1", null, { "d.md": "d" }, [], 3, {
          runId: run,
        }),
        instance.draft(chatId, "app-1"),
      ];
    });

    expect(saved).toStrictEqual([
      true,
      true,
      { base: null, changes: {}, definition: null, revision: 2 },
      false,
      true,
      true,
      false,
      false,
      { base: null, changes: {}, definition: null, revision: 4 },
    ]);
  });

  it("lands no first write that read the draft before a discard", async () => {
    const { chat } = await setUp([]);
    const chatId = chatIdSchema.parse(chat.chat.id);

    const saved = await runInDurableObject(chat.stub, (instance) => {
      const run = instance.openCodeRun(
        chatId,
        crypto.randomUUID(),
        testRunOpening
      );
      return [
        // A first write reads revision 0; a discard runs before it lands.
        instance.dropDraft(chatId, "app-1", { runId: run }),
        instance.saveDraft(chatId, "app-1", null, { "a.md": "a" }, [], 0, {
          runId: run,
        }),
        instance.draft(chatId, "app-1"),
      ];
    });

    expect(saved).toStrictEqual([
      true,
      false,
      { base: null, changes: {}, definition: null, revision: 1 },
    ]);
  });
});
