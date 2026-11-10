import { workspaceIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { workspace } from "../src/durable-objects.ts";
import {
  codeResults,
  codeStatuses,
  codeStep,
  model,
  says,
} from "./agent-chat.ts";
import {
  chatsWith,
  refusalsIn,
  watchOutput,
  withRevocationReads,
} from "./agent-code-runs.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { signedInWithRole } from "./sign-in.ts";

// A chat's agent, through the Workspace object: the loop, the code it runs
// in isolates of their own, and the model gateway, all real (agent-chat.ts).

const idp = mockIdp();

const { newChat, grantedChat } = chatsWith(idp);

describe("chat agent code output", () => {
  it("streams nothing a run logs after a revocation, even with no call to notice it", async () => {
    const { stub, chat, personId, ask, revoke } = await grantedChat(
      "export default async () => { console.log('before'); await scheduler.wait(2_500); console.log('after the revoke'); await scheduler.wait(2_500); return 'done'; };"
    );
    const { seen, latest } = await watchOutput(stub, chat.id, personId);

    const reply = ask("Log it.");
    await vi.waitFor(
      () => {
        expect(latest()?.text).toBe("before");
      },
      { timeout: 10_000, interval: 50 }
    );
    await revoke();
    await reply;

    expect(
      seen.some(
        ({ output }) => output?.text.includes("after the revoke") === true
      )
    ).toBeFalsy();
    await expect(codeStatuses(stub, chat.id)).resolves.toStrictEqual([
      "revoked",
    ]);
    expect(seen.at(-1)?.output ?? null).toBeNull();
  });

  it("drops what a run showed once a call of its finds a revocation", async () => {
    const { stub, chat, personId, ask, revoke } = await grantedChat(
      "export default async (self, env) => { console.log('shown'); await scheduler.wait(2_500); try { await env.chat.info(); } catch {} await scheduler.wait(1_000); return 'done'; };"
    );
    const { seen, latest } = await watchOutput(stub, chat.id, personId);

    const reply = ask("Log, then look.");
    await vi.waitFor(
      () => {
        expect(latest()?.text).toBe("shown");
      },
      { timeout: 10_000, interval: 50 }
    );
    await revoke();
    await reply;

    // Gone before the step's result came: with the refused call, not after.
    const shownAt = seen.findIndex(({ output }) => output?.text === "shown");
    const resultAt = seen.findIndex(({ result }) => result);
    expect(
      seen.slice(shownAt, resultAt).some(({ output }) => output === null)
    ).toBeTruthy();
  });

  it("shows nothing of a run whose revocation read fails, and records why", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async () => { console.log('read'); await scheduler.wait(1_500); return 'secret'; };"
      ),
      says("Done.")
    );
    const { seen } = await watchOutput(stub, chat.id, personId);

    await withRevocationReads(
      stub,
      async () => {
        await Promise.resolve();
        throw new Error("D1 is down for a moment");
      },
      async () => {
        await ask("Log it.");
      }
    );

    expect(seen.some(({ output }) => output !== null)).toBeFalsy();
    await expect(codeStatuses(stub, chat.id)).resolves.toStrictEqual([
      "revoked",
    ]);
    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.revocation_read_failed")
        ).resolves.toStrictEqual([
          {
            method: "output",
            outcome: "refused",
            reason: "agent.revocation_read_failed",
          },
        ]);
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("names the chat platform a chat came through in the record of a run's output it withheld", async () => {
    const { userId } = await signedInWithRole(idp, "user");
    const id = workspaceIdSchema.parse(crypto.randomUUID());
    const stub = workspace(env, id);
    const chat = await stub.createChat(
      "Questions",
      userId,
      id,
      undefined,
      "teams"
    );
    await fakeProvider(
      codeStep(
        "export default async () => { console.log('read'); await scheduler.wait(1_500); return 'secret'; };"
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
        await stub.ask(chat.id, { text: "Log it.", model });
      }
    );

    await vi.waitFor(
      async () => {
        const events = await allEvents();
        expect(
          events
            .filter(
              ({ action, detail }) =>
                action === "agent.call" &&
                detail.chat === chat.id &&
                detail.method === "output"
            )
            .map(({ actor }) => actor)
        ).toStrictEqual([
          { type: "agent", agentId: id, onBehalfOf: userId, via: "teams" },
        ]);
      },
      { timeout: 10_000, interval: 100 }
    );
  });

  it("holds a line until a revocation read begun after it finds none, however slow", async () => {
    const { stub, chat, personId, ask } = await newChat(
      codeStep(
        "export default async () => { console.log('held'); await scheduler.wait(1_000); return 'done'; };"
      ),
      says("Done.")
    );
    const { seen } = await watchOutput(stub, chat.id, personId);

    // Every read takes longer than the run: the line is never shown before
    // the step's result, which shows it.
    await withRevocationReads(
      stub,
      async () => {
        await scheduler.wait(3000);
      },
      async () => {
        await ask("Log it.");
      }
    );

    expect(seen.some(({ output }) => output !== null)).toBeFalsy();
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      { isError: false, text: "Logs:\nheld\n\nReturned:\ndone" },
    ]);
  });
});
