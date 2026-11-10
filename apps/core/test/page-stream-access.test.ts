import { GraspError } from "@grasp-os/runtime/client";
import { abortAllDurableObjects } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { mockSessionIdp, personApi } from "./page-client.ts";
import {
  apiOf,
  clientFor,
  post,
  refusal,
  settledCodeOf,
  storedOf,
  failureOf,
  ignoreProgress,
  openedApp,
  outcome,
  requestFor,
  titles,
  until,
} from "./page-stream.ts";
import { callAuth } from "./sign-in.ts";

// Foreground streaming actions (spec 10.7.6) and who may run them: at
// most four at once for a person, nothing kept of their input or
// progress, cancelled when their person signs out or loses the role,
// and concurrent starts under one key run once. page-stream.test.ts
// has the rest of a stream, page-stream-invocation.test.ts the
// invocation's own object.

mockSessionIdp();

describe("a streaming action's bounds and access", { timeout: 120_000 }, () => {
  it("runs at most four streams at once for a person in one App", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, page } = clientFor(opened);
    const steps = [0, 0, 0, 0];
    const slots = steps.map((_, slot) => ({
      input: { title: `Slot ${slot}` },
      key: `slot-${slot}`,
    }));
    const running = slots.map(async ({ input, key }, slot) => {
      try {
        return await client.stream(api.slow, input, {
          idempotencyKey: key,
          onProgress: () => {
            steps[slot] = (steps[slot] ?? 0) + 1;
          },
        });
      } catch (error) {
        return error instanceof GraspError ? error.code : "thrown";
      }
    });
    await until(() => steps.every((count) => count >= 1));
    const fifth = await failureOf(
      client.stream(
        api.draft,
        { topic: "fifth", pauseMs: 0 },
        { onProgress: ignoreProgress }
      )
    );
    for (const { input, key } of slots) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await page.transport.cancelStream?.(
        JSON.stringify(requestFor(api.slow, input, key))
      );
    }
    const ended = await Promise.all(running);
    // Its places come back as its streams end.
    const after = await client.stream(
      api.draft,
      { topic: "after", pauseMs: 0 },
      { onProgress: ignoreProgress }
    );
    expect({ fifth: fifth.code, ended, after }).toStrictEqual({
      fifth: "function.stream_limit",
      ended: steps.map(() => "function.cancelled"),
      after: { text: "Draft about after" },
    });
  });

  it("keeps a hash of the input and the result alone, never the input or its progress", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, page } = clientFor(opened);
    const input = { title: "Salary review for Ada" };
    const call = requestFor(api.slow, input, "kept-small");
    let steps = 0;
    const running = failureOf(
      client.stream(api.slow, input, {
        idempotencyKey: "kept-small",
        onProgress: () => {
          steps += 1;
        },
      })
    );
    await until(() => steps >= 1);
    await page.transport.cancelStream?.(JSON.stringify(call));
    await running;
    const stored = await storedOf(opened, call, "kept-small");
    expect({
      input: stored.includes("Salary review"),
      progress: stored.includes('"step"'),
      settled: stored.includes('"settled"'),
    }).toStrictEqual({ input: false, progress: false, settled: true });
  });

  it("cancels a stream that emits nothing at once when its person signs out", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const input = { title: "Late", pauseMs: 9000 };
    let steps = 0;
    const running = failureOf(
      client.stream(api.quiet, input, {
        idempotencyKey: "signed-out",
        onProgress: () => {
          steps += 1;
        },
      })
    );
    await until(() => steps >= 1);
    await callAuth("/sign-out", opened.builder.cookie, {});
    const failed = await running;
    // Cancelled when the relay saw it, well before it would have ended.
    expect({
      failed: failed.code,
      settled: await settledCodeOf(
        opened,
        requestFor(api.quiet, input, "signed-out"),
        "signed-out"
      ),
    }).toStrictEqual({
      failed: "auth.unauthenticated",
      settled: "function.cancelled",
    });
  });

  it("cancels a stream that emits nothing at once when its person's role narrows", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const input = { title: "Late", pauseMs: 9000 };
    let steps = 0;
    const running = failureOf(
      client.stream(api.quiet, input, {
        idempotencyKey: "narrowed",
        onProgress: () => {
          steps += 1;
        },
      })
    );
    await until(() => steps >= 1);
    await opened.admin.api.members.setRole(opened.builderId, "user");
    const failed = await running;
    expect({
      failed: failed.code,
      settled: await settledCodeOf(
        opened,
        requestFor(api.quiet, input, "narrowed"),
        "narrowed"
      ),
    }).toStrictEqual({
      failed: "function.access_changed",
      settled: "function.cancelled",
    });
  });

  it("withholds a finished stream's receipt from its person once their role narrowed", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = {
      idempotencyKey: "before-demotion",
      onProgress: ignoreProgress,
    };
    const input = { topic: "budget", pauseMs: 0 };
    await client.stream(api.draft, input, keyed);
    await opened.admin.api.members.setRole(opened.builderId, "user");
    await expect(
      failureOf(client.stream(api.draft, input, keyed))
    ).resolves.toMatchObject({
      code: "function.access_changed",
    });
  });

  it("keeps one App's stream from another App's path, under the same key", async () => {
    const opened = await openedApp();
    const other = await openedApp({
      builder: opened.builderApi,
      admin: opened.admin,
    });
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const input = { topic: "mine", pauseMs: 0 };
    await client.stream(api.draft, input, {
      idempotencyKey: "one-app",
      onProgress: ignoreProgress,
    });
    const attached = await post(
      other.app,
      other.builder,
      "/attach",
      JSON.stringify(requestFor(api.draft, input, "one-app"))
    );
    await expect(attached.text()).resolves.toContain(
      '"code":"submission.expired"'
    );
  });

  it("refuses a stream to a frame without a lease, as code core didn't serve", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const response = await post(
      opened.app,
      { ...opened.builder, lease: "" },
      "/stream",
      JSON.stringify(
        requestFor(api.draft, { topic: "x", pauseMs: 0 }, "no-lease")
      )
    );
    const refused: unknown = Reflect.get(await refusal(response), "code");
    expect({ status: response.status, code: refused }).toStrictEqual({
      status: 403,
      code: "page.unreviewed",
    });
  });

  it("refuses a stream to a frame that names someone other than the person signed in, or no one", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const request = JSON.stringify(
      requestFor(api.draft, { topic: "x", pauseMs: 0 }, "someone-else")
    );
    const codeOf = async (named: string) => {
      const response = await post(
        opened.app,
        { ...opened.builder, person: named },
        "/stream",
        request
      );
      const code: unknown = Reflect.get(await refusal(response), "code");
      return { status: response.status, code };
    };
    expect({
      someoneElse: await codeOf(opened.other.person),
      noOne: await codeOf(""),
    }).toStrictEqual({
      someoneElse: { status: 401, code: "auth.principal_changed" },
      noOne: { status: 401, code: "auth.principal_changed" },
    });
  });
});

describe(
  "a streaming action under concurrent and changing access",
  { timeout: 120_000 },
  () => {
    it("runs once for two starts under one key at the same time, and refuses one with other input", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const { client } = clientFor(opened);
      const keyed = {
        idempotencyKey: "twice-at-once",
        onProgress: ignoreProgress,
      };
      const input = { topic: "once", pauseMs: 200 };
      const both = await Promise.all([
        client.stream(api.draft, input, keyed),
        client.stream(api.draft, input, keyed),
      ]);
      const other = {
        idempotencyKey: "other-input",
        onProgress: ignoreProgress,
      };
      const raced = await Promise.all([
        outcome(client.stream(api.draft, { topic: "a", pauseMs: 200 }, other)),
        outcome(client.stream(api.draft, { topic: "b", pauseMs: 200 }, other)),
      ]);
      const notes = await titles(client, opened);
      expect({
        both,
        raced: raced.toSorted(),
        notes: notes.length,
      }).toStrictEqual({
        both: [{ text: "Draft about once" }, { text: "Draft about once" }],
        raced: ["resolved", "submission.key_conflict"],
        // One for the first key, one for the start that won the second.
        notes: 2,
      });
    });

    it("withholds a finished stream's receipt from someone whose role in the App narrowed", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const shared = await personApi("builder");
      await opened.builderApi.api.apps.members.add(opened.app, {
        type: "person",
        id: shared.userId,
        role: "builder",
      });
      const { lease } = await shared.api.pages.open(opened.app);
      const { client } = clientFor(opened, {
        lease,
        cookie: shared.session,
        person: shared.userId,
      });
      const keyed = {
        idempotencyKey: "app-builder",
        onProgress: ignoreProgress,
      };
      const input = { topic: "builders", pauseMs: 0 };
      await client.stream(api.draft, input, keyed);
      // Their organization role and teams stay; their role in the App narrows.
      await opened.builderApi.api.apps.members.add(opened.app, {
        type: "person",
        id: shared.userId,
        role: "user",
      });
      await expect(
        failureOf(client.stream(api.draft, input, keyed))
      ).resolves.toMatchObject({
        code: "function.access_changed",
      });
    });

    it("keeps recovering when a reconnect is refused for the request budget", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const { client, page } = clientFor(opened);
      page.cut();
      page.refuseAttaches(1);
      await expect(
        client.stream(
          api.draft,
          { topic: "budget", pauseMs: 400 },
          { onProgress: ignoreProgress }
        )
      ).resolves.toStrictEqual({ text: "Draft about budget" });
    });

    it("keeps a person's places for running streams through a restart of the App's object", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const { client } = clientFor(opened);
      const steps = [0, 0, 0, 0];
      const running = steps.map(
        async (_, slot) =>
          await failureOf(
            client.stream(
              api.slow,
              { title: `Kept ${slot}` },
              {
                idempotencyKey: `kept-${slot}`,
                onProgress: () => {
                  steps[slot] = (steps[slot] ?? 0) + 1;
                },
              }
            )
          ).catch(() => null)
      );
      await until(() => steps.every((count) => count >= 1));
      // Every object starts afresh, the App's among them; what they stored stays.
      await abortAllDurableObjects();
      const fifth = await failureOf(
        client.stream(
          api.draft,
          { topic: "fifth", pauseMs: 0 },
          { onProgress: ignoreProgress }
        )
      );
      await Promise.all(running);
      expect(fifth.code).toBe("function.stream_limit");
    });
  }
);
