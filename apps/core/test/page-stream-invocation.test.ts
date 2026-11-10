import { actionMaxRunning } from "@grasp-os/shared/function-limits";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import {
  abortAllDurableObjects,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { invokeAppAction } from "../src/app-functions.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { mockSessionIdp } from "./page-client.ts";
import {
  apiOf,
  clientFor,
  endOf,
  failureOf,
  ignoreProgress,
  invocationOf,
  openedApp,
  published,
  requestFor,
  tooDeep,
  until,
} from "./page-stream.ts";
import { person } from "./sealed-apps.ts";

// An action's invocation's own Durable Object (spec 10.7.6): how it
// decides starts, cancels and outcomes, and what it holds and keeps.
// page-stream.test.ts and page-stream-access.test.ts have the streams
// themselves.

mockSessionIdp();

describe("an action's invocation object", { timeout: 120_000 }, () => {
  it("decides a cancel sent while a start is being decided after it, and cancels the run", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const call = requestFor(
      api.draft,
      { topic: "stop", pauseMs: 300 },
      "cancel-at-start"
    );
    const { stub, open } = await invocationOf(
      opened,
      call,
      "cancel-at-start",
      true
    );
    const [frames, requested] = await Promise.all([
      open(),
      stub.cancel(opened.builderId),
    ]);
    expect({ requested, end: await endOf(frames) }).toStrictEqual({
      requested: true,
      end: "function.cancelled",
    });
  });

  it("holds at most sixteen plain runs at once for a person in one App, recording nothing past them", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const runs = await Promise.all(
      Array.from({ length: actionMaxRunning }, async (_, slot) => {
        const call = requestFor(api.waits, { pauseMs: 5000 }, `plain-${slot}`);
        const invocation = await invocationOf(
          opened,
          call,
          `plain-${slot}`,
          false
        );
        return { ...invocation, frames: await invocation.open() };
      })
    );
    const past = requestFor(api.waits, { pauseMs: 0 }, "plain-past");
    const pastRun = await invocationOf(opened, past, "plain-past", false);
    const refused = await pastRun.open();
    const end = await endOf(refused);
    for (const { stub } of runs) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await stub.cancel(opened.builderId);
    }
    const ended = await Promise.all(
      runs.map(async ({ frames }) => await endOf(frames))
    );
    // Nothing was recorded: the same key starts once there is room.
    const again = await endOf(await pastRun.open());
    expect({ end, ended: new Set(ended), again }).toStrictEqual({
      end: "function.action_limit",
      ended: new Set(["function.cancelled"]),
      again: "ok",
    });
  });

  it("refuses input too deep to read, so two such inputs never share a key's run", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const ends = async (
      reference: typeof api.draft | typeof api.echo,
      key: string,
      streaming: boolean,
      readable: Json
    ) => {
      const endFor = async (input: Json): Promise<string> => {
        const call = requestFor(reference, input, key);
        const { open } = await invocationOf(opened, call, key, streaming);
        return await endOf(await open());
      };
      return [
        await endFor({ topic: tooDeep("a", 40) }),
        await endFor({ topic: tooDeep("b", 40) }),
        // Nothing was recorded under the key: readable input runs.
        await endFor(readable),
      ];
    };
    expect({
      streaming: await ends(api.draft, "deep-stream", true, {
        topic: "readable",
        pauseMs: 0,
      }),
      plain: await ends(api.echo, "deep-plain", false, { word: "readable" }),
    }).toStrictEqual({
      streaming: ["contract.invalid_request", "contract.invalid_request", "ok"],
      plain: ["contract.invalid_request", "contract.invalid_request", "ok"],
    });
  });

  it("keeps no receipt of a refusal that ran nothing of the App's", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    // A plain action through the streaming path: refused before it runs.
    const call = requestFor(api.echo, {}, "ran-nothing");
    const { stub, open } = await invocationOf(
      opened,
      call,
      "ran-nothing",
      true
    );
    const end = await endOf(await open());
    const stored = await runInDurableObject(stub, (_instance, state) =>
      JSON.stringify([...state.storage.kv.list()])
    );
    expect({ end, stored }).toStrictEqual({
      end: "function.mode_mismatch",
      stored: "[]",
    });
  });

  it("answers a receipt across a publish that keeps the contract, running nothing again", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    const keyed = {
      idempotencyKey: "across-publish",
      onProgress: ignoreProgress,
    };
    // How many notes there were before it ran: run again, it would say one.
    const first = await client.stream(apiOf(opened.release).counts, {}, keyed);
    const second = await published(opened);
    const again = await client.stream(apiOf(second).counts, {}, keyed);
    expect({ first, again }).toStrictEqual({ first: 0, again: 0 });
  });

  it("runs an action only in the version its invocation recorded, refused once another is current", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const by = {
      userId: opened.builderId,
      role: "builder" as const,
      teams: [],
    };
    const app = appIdSchema.parse(opened.app);
    // As the invocation object runs it, after recording `version`: a
    // publish in between never runs code its record doesn't name, so
    // revoking what ran stops its result.
    const runIn = async (version: number) => {
      const { result } = await invokeAppAction(
        env,
        by,
        app,
        requestFor(api.echo, { word: "recorded" }, `in-${version}`),
        {
          version,
          cancelled: new AbortController().signal,
          deadline: Date.now() + 30_000,
        }
      );
      return result.ok ? result.value : result.error.code;
    };
    const current = await runIn(1);
    await published(opened);
    expect({
      current,
      passed: await runIn(1),
      now: await runIn(2),
    }).toStrictEqual({
      current: "recorded",
      passed: "version.mismatch",
      now: "recorded",
    });
  });

  it("refuses a receipt of a release revoked since", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    const api = apiOf(opened.release);
    const input = { topic: "revoked", pauseMs: 0 };
    const keyed = {
      idempotencyKey: "revoked-receipt",
      onProgress: ignoreProgress,
    };
    await client.stream(api.draft, input, keyed);
    await published(opened);
    await revokeRelease(
      env,
      await person("admin"),
      { app: appIdSchema.parse(opened.app), version: 1 },
      "Leaks data"
    );
    // The frame was opened on version 1: its build is revoked with it.
    await expect(
      failureOf(client.stream(api.draft, input, keyed))
    ).resolves.toMatchObject({
      code: "page.revoked",
    });
  });

  it("stops relaying a stream whose release is revoked while it runs, after a later one is published", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    let steps = 0;
    const running = client.stream(
      api.slow,
      { title: "Made under one" },
      {
        onProgress: () => {
          steps += 1;
        },
      }
    );
    await until(() => steps >= 1);
    await published(opened);
    await revokeRelease(
      env,
      await person("admin"),
      { app: appIdSchema.parse(opened.app), version: 1 },
      "Leaks data"
    );
    const revokedAt = Date.now();
    // The frame was opened on version 1: its build is revoked with it.
    await expect(failureOf(running)).resolves.toMatchObject({
      code: "page.revoked",
    });
    // Stopped at the relay's next check, not once the run ends (40 s on).
    expect(Date.now() - revokedAt).toBeLessThan(15_000);
  });

  it("refuses a receipt made under a release revoked since, to a caller of a later one", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    const input = { topic: "made under one", pauseMs: 0 };
    const keyed = {
      idempotencyKey: "made-under-v1",
      onProgress: ignoreProgress,
    };
    await client.stream(apiOf(opened.release).draft, input, keyed);
    const second = await published(opened);
    await revokeRelease(
      env,
      await person("admin"),
      { app: appIdSchema.parse(opened.app), version: 1 },
      "Leaks data"
    );
    // A page opened on version 2, with its own lease: the same contract,
    // the same invocation, made under 1.
    const { lease } = await opened.builderApi.api.pages.open(opened.app);
    const later = clientFor(opened, { ...opened.builder, lease });
    await expect(
      failureOf(later.client.stream(apiOf(second).draft, input, keyed))
    ).resolves.toMatchObject({ code: "version.revoked" });
  });

  it("settles a run stuck past its deadline as unknown, with the key", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const input = { title: "Stuck", pauseMs: 2000 };
    let steps = 0;
    const running = failureOf(
      client.stream(api.quiet, input, {
        onProgress: () => {
          steps += 1;
        },
        idempotencyKey: "stuck",
      })
    );
    await until(() => steps >= 1);
    const call = requestFor(api.quiet, input, "stuck");
    const { stub } = await invocationOf(opened, call, "stuck", true);
    // As if its run ignored its deadline: the deadline long past.
    await runInDurableObject(stub, (_instance, state) => {
      const record = z
        .object({ deadline: z.number() })
        .loose()
        .parse(state.storage.kv.get("invocation"));
      state.storage.kv.put("invocation", {
        ...record,
        deadline: Date.now() - 120_000,
      });
    });
    await runDurableObjectAlarm(stub);
    await expect(running).resolves.toMatchObject({
      code: "function.outcome_unknown",
      details: { idempotencyKey: "stuck" },
    });
    // Its run ends later after all: what was said of it stands.
    await scheduler.wait(2500);
    await expect(
      failureOf(
        client.stream(api.quiet, input, {
          onProgress: ignoreProgress,
          idempotencyKey: "stuck",
        })
      )
    ).resolves.toMatchObject({ code: "function.outcome_unknown" });
  });

  it("carries the key on an uncertain outcome its caller didn't choose a key for", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    let steps = 0;
    const running = failureOf(
      client.stream(
        api.slow,
        { title: "Restarted" },
        {
          onProgress: () => {
            steps += 1;
          },
        }
      )
    );
    await until(() => steps >= 1);
    // Its object restarts while it runs: whether it finished is unknown.
    await abortAllDurableObjects();
    const failed = await running;
    expect({
      code: failed.code,
      key: z.object({ idempotencyKey: z.string() }).safeParse(failed.details)
        .success,
    }).toStrictEqual({ code: "function.outcome_unknown", key: true });
  });
});
