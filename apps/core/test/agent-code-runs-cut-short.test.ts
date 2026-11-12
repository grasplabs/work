import { chatIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { workspace } from "../src/durable-objects.ts";
import { codeResults, codeStep, says } from "./agent-chat.ts";
import { chatsWith, runRecords, toolCallIds } from "./agent-code-runs.ts";
import { mockIdp } from "./idp.ts";

// A chat's agent, through the Workspace object: the loop, the code it runs
// in isolates of their own, and the model gateway, all real (agent-chat.ts).

const idp = mockIdp();

const { newChat } = chatsWith(idp);

describe("chat agent code run leases", () => {
  it("ends a run's lease a Workspace restart cuts short: its record says interrupted, its later calls are refused, and the turn goes on in its ChatSession", async () => {
    const { id, stub, chat, provider, ask } = await newChat(
      codeStep(
        "export default async (self, env) => { await env.chat.info(); await scheduler.wait(5_000); return (await env.chat.info()).chatId; };"
      ),
      says("Done.")
    );

    const reply = ask("Look twice.").catch(() => "cut short");
    await vi.waitFor(
      async () => {
        await expect(
          runRecords(stub, chat.id).then((records) => records.length)
        ).resolves.toBe(1);
      },
      { timeout: 10_000 }
    );
    // The object dies, as a restart ends it: everything in flight fails.
    await runInDurableObject(stub, (_instance, state) => {
      state.abort("restart");
    }).catch(() => "aborted");
    await expect(reply).resolves.toBe("cut short");
    // The object as it wakes again.
    const woken = workspace(env, id);

    const [record] = await runRecords(woken, chat.id);
    expect(record?.status).toBe("interrupted");
    // Its lease went with the object: its stubs answer as ended.
    await expect(
      runInDurableObject(woken, (instance) =>
        instance.callFromCodeRun(
          chatIdSchema.parse(chat.id),
          String(record?.id)
        )
      )
    ).resolves.toMatchObject({ call: "ended" });
    // The turn goes on in the chat's ChatSession at once, not at its
    // heartbeat alarm a minute on: the run's call fails with the object it
    // went to, its step fails, and the model answers. Not run again.
    await vi.waitFor(
      () => {
        expect(provider.requests).toHaveLength(2);
      },
      { timeout: 15_000 }
    );
    const [calls, results, runs] = await Promise.all([
      toolCallIds(woken, chat.id),
      codeResults(woken, chat.id),
      runRecords(woken, chat.id),
    ]);
    expect({
      calls: calls.length,
      failed: results.map(({ isError }) => isError),
      runs: runs.length,
    }).toStrictEqual({ calls: 1, failed: [true], runs: 1 });
  });
});
