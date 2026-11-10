import piAgentCore from "@earendil-works/pi-agent-core/package.json" with { type: "json" };
import { agentErrors } from "@grasp-os/shared/agent";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { codeRuntime, sourceHash } from "../src/code-mode.ts";
import {
  codeResults,
  codeStatuses,
  codeStep,
  says,
  setObjectEnv,
  testRunOpening,
} from "./agent-chat.ts";
import {
  chatsWith,
  refusalsIn,
  runRecords,
  toolCallIds,
  withRevocationReads,
} from "./agent-code-runs.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import { signedInApi } from "./sign-in.ts";

// A chat's agent, through the Workspace object: the loop, the code it runs
// in isolates of their own, and the model gateway, all real (agent-chat.ts).

const idp = mockIdp();

const { newChat } = chatsWith(idp);

/**
 * A revoked permission of `agentId`, stored as a revocation leaves one:
 * granted before, or (`granted: false`) a request declined before anyone
 * granted it; held everywhere, or in one chat.
 */
const revokedRow = async (
  agentId: string,
  { granted, chatId }: { granted: boolean; chatId: string | null }
) => {
  await env.DB.prepare(
    `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
      actions, binding, status, requested_by, requested_at, granted_by, granted_at,
      revoked_by, revoked_at, chat_id)
     VALUES (?, 'agent', ?, 'collection', ?, '["read"]', ?, 'revoked', 'test', 0, ?, ?, 'test', ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      agentId,
      crypto.randomUUID(),
      `R${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`.toUpperCase(),
      granted ? "test" : null,
      granted ? 0 : null,
      Date.now(),
      chatId
    )
    .run();
};

/** Whether `call` threw `code`, the way the object's RPC hands it on. */
const refusedWith = async (call: () => unknown) => {
  try {
    await call();
  } catch (error) {
    return agentErrors.codeOf(error) ?? "failed";
  }
  return "admitted";
};

describe("chat agent code run leases", () => {
  it("keeps a record of every run: its call, its module's hash, the agent and runtime it ran on, and how it ended", async () => {
    const code = "export default async () => 6 * 7;";
    const { stub, chat, ask } = await newChat(codeStep(code), says("42."));

    await ask("What is 6 * 7?");

    const [record] = await runRecords(stub, chat.id);
    const [toolCallId] = await toolCallIds(stub, chat.id);
    expect({ ...record, id: typeof record?.id }).toStrictEqual({
      id: "string",
      tool_call_id: toolCallId,
      source_hash: await sourceHash(code),
      source_chars: code.length,
      agent: `@earendil-works/pi-agent-core@${piAgentCore.version}`,
      compatibility_date: "2026-09-15",
      // Plain workerd doesn't enforce the isolate's CPU limit, and the
      // record says so rather than claim it.
      runtime: "workerd",
      cpu_limit: "cpu_limit_unsupported",
      status: "completed",
    });
  });

  it("refuses every write of a run whose lease closed, in the write's own transaction", async () => {
    const { stub, chat } = await newChat();
    const chatId = chatIdSchema.parse(chat.id);
    const write = (runId: string, revision: number) => async () =>
      await stub.saveDraft(
        chatId,
        "app-1",
        null,
        { "a.md": "a" },
        [],
        revision,
        { runId }
      );

    // Open: written. Ended (completed, cancelled, timed out): refused.
    const ended = await stub.openCodeRun(
      chatId,
      crypto.randomUUID(),
      testRunOpening
    );
    const first = await refusedWith(write(ended, 0));
    await stub.closeCodeRun(chatId, ended, "wall_expired");
    // Revoked while open: refused as revoked, however it then ends.
    const revoked = await stub.openCodeRun(
      chatId,
      crypto.randomUUID(),
      testRunOpening
    );
    await stub.revokeCodeRun(chatId, revoked);

    expect({
      first,
      afterEnd: await refusedWith(write(ended, 1)),
      discardAfterEnd: await refusedWith(
        async () => await stub.dropDraft(chatId, "app-1", { runId: ended })
      ),
      afterRevoke: await refusedWith(write(revoked, 1)),
      createAfterRevoke: await refusedWith(
        async () => await stub.takeCreate(chatId, 3, revoked)
      ),
      unknownRun: await refusedWith(write(crypto.randomUUID(), 1)),
      ending: await stub.closeCodeRun(chatId, revoked, "completed"),
      draft: await stub.draft(chatId, "app-1"),
    }).toStrictEqual({
      first: "admitted",
      afterEnd: "agent.run_ended",
      discardAfterEnd: "agent.run_ended",
      afterRevoke: "agent.run_revoked",
      createAfterRevoke: "agent.run_revoked",
      unknownRun: "agent.run_ended",
      ending: "revoked",
      draft: {
        base: null,
        changes: { "a.md": "a" },
        definition: null,
        revision: 1,
      },
    });
    await expect(
      runRecords(stub, chat.id).then((records) =>
        records.map(({ status }) => status)
      )
    ).resolves.toStrictEqual(["wall_expired", "revoked"]);
  });

  it("closes a run's lease when a permission of its agent is revoked while it runs, and admits nothing after", async () => {
    const admin = await signedInApi(idp, "admin");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Handbook ${crypto.randomUUID()}`,
      access: "everyone",
    });
    // Long enough that the revoke always comes first, however slow the
    // runner: the revoke closes the run, not the wait.
    const { stub, chat, agent, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { await env.chat.info(); await scheduler.wait(5_000); try { await env.chat.info(); return 'answered'; } catch (error) { return String(error.message); } };"
      ),
      says("Done.")
    );
    const permission = await requestGranted(
      idp,
      admin,
      readCollection(agent, collectionId, "HANDBOOK")
    );

    const reply = ask("Look twice.");
    await vi.waitFor(
      async () => {
        await expect(
          runRecords(stub, chat.id).then((records) => records.length)
        ).resolves.toBe(1);
      },
      { timeout: 10_000 }
    );
    await admin.api.permissions.revoke(permission);
    await reply;

    // What the code returned rests on what was revoked: not handed on.
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: true,
        text: `Error (revoked):\n${agentErrors.create("agent.run_revoked").message}`,
      },
    ]);
    await expect(
      runRecords(stub, chat.id).then((records) =>
        records.map(({ status }) => status)
      )
    ).resolves.toStrictEqual(["revoked"]);
    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.run_revoked")
        ).resolves.toStrictEqual([
          {
            method: "chat.info",
            outcome: "refused",
            reason: "agent.run_revoked",
          },
        ]);
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("notices a revocation the code never called after: it ends revoked, and hands on neither its result nor its logs", async () => {
    const admin = await signedInApi(idp, "admin");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Handbook ${crypto.randomUUID()}`,
      access: "everyone",
    });
    const { stub, chat, agent, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { const files = await env.chat.files(); await scheduler.wait(3_000); console.log('leaked', files.length); return 'read before the revoke'; };"
      ),
      says("Done.")
    );
    const permission = await requestGranted(
      idp,
      admin,
      readCollection(agent, collectionId, "HANDBOOK")
    );

    const reply = ask("Look once.");
    // Revoked once the code's one call was answered, so it calls nothing
    // after: the run notices the revocation as it ends, not at a call.
    await vi.waitFor(
      async () => {
        const events = await allEvents();
        expect(
          events.some(
            ({ action, detail }) =>
              action === "agent.call" &&
              detail.chat === chat.id &&
              detail.method === "chat.files" &&
              detail.outcome === "ok"
          )
        ).toBeTruthy();
      },
      { timeout: 10_000, interval: 50 }
    );
    await admin.api.permissions.revoke(permission);
    await reply;

    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: true,
        text: `Error (revoked):\n${agentErrors.create("agent.run_revoked").message}`,
      },
    ]);
    await expect(
      runRecords(stub, chat.id).then((records) =>
        records.map(({ status }) => status)
      )
    ).resolves.toStrictEqual(["revoked"]);
    // Noticed at the line it logged, which comes before its end and is
    // checked before the run closes: once, there.
    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.run_revoked")
        ).resolves.toStrictEqual([
          {
            method: "output",
            outcome: "refused",
            reason: "agent.run_revoked",
          },
        ]);
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("leaves a run alone when what was revoked never gave it authority: a request never granted, or another chat's permission", async () => {
    const { stub, chat, agent, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { await env.chat.info(); await scheduler.wait(1_500); return (await env.chat.info()).chatId; };"
      ),
      says("Done.")
    );

    const reply = ask("Look twice.");
    await vi.waitFor(
      async () => {
        await expect(
          runRecords(stub, chat.id).then((records) => records.length)
        ).resolves.toBe(1);
      },
      { timeout: 10_000 }
    );
    // As a person declining the chat's request stores it, and as a
    // revocation in another of the agent's chats does.
    await revokedRow(agent.agentId, { granted: false, chatId: chat.id });
    await revokedRow(agent.agentId, {
      granted: true,
      chatId: crypto.randomUUID(),
    });
    await reply;

    await expect(codeStatuses(stub, chat.id)).resolves.toStrictEqual([
      "completed",
    ]);
    await expect(
      refusalsIn(chat.id, "agent.run_revoked")
    ).resolves.toStrictEqual([]);
  });

  it("takes a CPU limit as enforced only where the deployment says it runs on Cloudflare", () => {
    expect(
      [undefined, "workerd", "Cloudflare", "cloudflare"].map(
        (profile) =>
          codeRuntime(profile === undefined ? {} : { RUNTIME_PROFILE: profile })
            .cpuLimit
      )
    ).toStrictEqual([
      "cpu_limit_unsupported",
      "cpu_limit_unsupported",
      "cpu_limit_unsupported",
      "enforced",
    ]);
  });

  it("closes a run's lease as it ends whatever the revocation read does, and withholds its result when the read fails", async () => {
    const { stub, chat, ask } = await newChat(
      codeStep(
        "export default async () => { console.log('read'); return 'secret'; };"
      ),
      says("Done.")
    );

    await withRevocationReads(
      stub,
      async () => {
        await Promise.resolve();
        throw new Error("D1 is down for a moment");
      },
      async () => {
        await ask("Return it.");
      }
    );

    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: true,
        text: `Error (revoked):\n${agentErrors.create("agent.run_revoked").message}`,
      },
    ]);
    const [record] = await runRecords(stub, chat.id);
    expect(record?.status).toBe("revoked");
    const { call } = await runInDurableObject(stub, (instance) =>
      instance.admitFromCodeRun(chatIdSchema.parse(chat.id), String(record?.id))
    );
    // Closed, as ended or, once the chat's guard withheld it first, as
    // revoked: nothing more of it is admitted either way.
    expect(["ended", "revoked"]).toContain(call);
  });

  it("admits nothing a run does while its end reads revocations", async () => {
    // The run ends at its wall clock while its code still waits; the code
    // calls during the slow read of revocations that follows.
    const { stub, chat, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { await scheduler.wait(1_300); await env.chat.files(); };"
      ),
      says("Done.")
    );
    await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "1000" });
    try {
      await withRevocationReads(
        stub,
        async () => {
          await scheduler.wait(2000);
        },
        async () => {
          await ask("Wait, then look.");
        }
      );
    } finally {
      await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "" });
    }

    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.run_ended")
        ).resolves.toStrictEqual([
          {
            method: "chat.files",
            outcome: "refused",
            reason: "agent.run_ended",
          },
        ]);
      },
      { timeout: 10_000, interval: 100 }
    );
    await expect(codeStatuses(stub, chat.id)).resolves.toStrictEqual([
      "wall_expired",
    ]);
  });
});
