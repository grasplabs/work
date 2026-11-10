import { chatIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { workspace } from "../src/durable-objects.ts";
import { codeResults, codeStep, says, setObjectEnv } from "./agent-chat.ts";
import {
  chatsWith,
  refusalsIn,
  runRecords,
  toolCallIds,
} from "./agent-code-runs.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";

// A chat's agent, through the Workspace object: the loop, the code it runs
// in isolates of their own, and the model gateway, all real (agent-chat.ts).

const idp = mockIdp();

const { newChat } = chatsWith(idp);

/** `statement`, answering two seconds late, as its bound copies do. */
const lateStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
  new Proxy(statement, {
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      if (property === "bind") {
        return (...args: unknown[]) => lateStatement(target.bind(...args));
      }
      return async (...args: unknown[]): Promise<unknown> => {
        await scheduler.wait(2000);
        return await Reflect.apply(value, target, args);
      };
    },
  });

describe("chat agent code run leases", () => {
  it("saves no USER.md for a run that ran out of time while the save was prepared", async () => {
    const { stub, chat, agent, ask } = await newChat(
      codeStep(
        "export default async (self, env) => await env.memory.saveUser({ text: 'Prefers short answers.', ifVersion: 0 });"
      ),
      says("It ran out of time.")
    );
    // Knowledge answers two seconds late; the run has a second. The save
    // is let in as it starts, then prepared past the run's end.
    const { KNOWLEDGE: knowledge } = env;
    const slow = new Proxy(knowledge, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "prepare") {
          return (query: string) => lateStatement(target.prepare(query));
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "1000" });
    env.KNOWLEDGE = slow;
    try {
      await ask("Remember it.");
    } finally {
      env.KNOWLEDGE = knowledge;
      await setObjectEnv(stub, { CODE_RUN_TIMEOUT_MS: "" });
    }

    await vi.waitFor(
      async () => {
        await expect(
          refusalsIn(chat.id, "agent.run_ended")
        ).resolves.toStrictEqual([
          {
            method: "memory.saveUser",
            outcome: "refused",
            reason: "agent.run_ended",
          },
        ]);
      },
      { timeout: 30_000, interval: 200 }
    );
    const events = await allEvents();
    expect(
      events.filter(
        ({ action, actor }) =>
          action === "knowledge.document.saved" &&
          actor.type === "agent" &&
          actor.agentId === agent.agentId
      )
    ).toStrictEqual([]);
  });

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
