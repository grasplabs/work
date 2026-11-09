import { describe, expect, it } from "vite-plus/test";

import { mockSessionIdp } from "./page-client.ts";
import {
  apiOf,
  clientFor,
  failureOf,
  ignoreProgress,
  openedApp,
  post,
  titles,
  until,
} from "./page-stream.ts";

// Foreground streaming actions (spec 10.7.6), through core's real routes
// and the invocation's own Durable Object, as a page's page
// relays them: progress then the validated result; a lost connection
// attached to the same invocation, never run again; a cancelled stream
// that keeps what it committed and commits nothing more; a stream no one
// follows cancelled; another person, a reused key and a revoked build
// refused; progress its schema refuses failing the action; a reference of
// the wrong mode refused both ways.
// page-stream-access.test.ts has a stream's bounds and who may run it,
// page-stream-invocation.test.ts the invocation's own object.

mockSessionIdp();

describe("a streaming action", { timeout: 120_000 }, () => {
  it("streams whole progress snapshots, then resolves its validated result", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const seen: { text: string }[] = [];
    const result = await client.stream(
      api.draft,
      { topic: "launch" },
      {
        onProgress: (progress) => {
          seen.push(progress);
        },
      }
    );
    // Snapshots, never deltas: the newest last, each frozen.
    expect({
      result,
      last: seen.at(-1),
      frozen: seen.every((progress) => Object.isFrozen(progress)),
      notes: await titles(client, opened),
    }).toStrictEqual({
      result: { text: "Draft about launch" },
      last: { text: "Draft about launch" },
      frozen: true,
      notes: ["Draft about launch"],
    });
  });

  it("goes on when its progress callback throws", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    let calls = 0;
    await expect(
      client.stream(
        api.draft,
        { topic: "again" },
        {
          onProgress: () => {
            calls += 1;
            throw new Error("The page's bug");
          },
        }
      )
    ).resolves.toStrictEqual({ text: "Draft about again" });
    expect(calls).toBe(1);
  });

  it("attaches to the same invocation after a lost connection, running it once", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, page } = clientFor(opened);
    page.cut();
    const result = await client.stream(
      api.draft,
      { topic: "once", pauseMs: 400 },
      { onProgress: ignoreProgress }
    );
    // Started once, then only ever attached to; its effect made once.
    expect({
      result,
      opened: [...new Set(page.opened)],
      notes: await titles(client, opened),
    }).toStrictEqual({
      result: { text: "Draft about once" },
      opened: ["stream", "attach"],
      notes: ["Draft about once"],
    });
  });

  it("answers a finished invocation's receipt to the same key, without running it again", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = {
      idempotencyKey: "draft-receipt",
      onProgress: ignoreProgress,
    };
    const first = await client.stream(
      api.draft,
      { topic: "kept", pauseMs: 0 },
      keyed
    );
    const again = await client.stream(
      api.draft,
      { topic: "kept", pauseMs: 0 },
      keyed
    );
    expect({ first, again, notes: await titles(client, opened) }).toStrictEqual(
      {
        first: { text: "Draft about kept" },
        again: { text: "Draft about kept" },
        notes: ["Draft about kept"],
      }
    );
  });

  it("refuses a key reused with other input, and another person's attach", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = { idempotencyKey: "mine", onProgress: ignoreProgress };
    await client.stream(api.draft, { topic: "a", pauseMs: 0 }, keyed);
    await expect(
      failureOf(client.stream(api.draft, { topic: "b", pauseMs: 0 }, keyed))
    ).resolves.toMatchObject({ code: "submission.key_conflict" });
    // The same reference, key and input, from another person's page:
    // no invocation of theirs has it.
    const request = JSON.stringify({
      reference: { name: api.draft.name, kind: "action" },
      input: { topic: "a", pauseMs: 0 },
      idempotencyKey: "mine",
    });
    const attached = await post(opened.app, opened.other, "/attach", request);
    expect(attached.ok).toBeTruthy();
    await expect(attached.text()).resolves.toContain(
      '"code":"submission.expired"'
    );
    const cancelled = await post(opened.app, opened.other, "/cancel", request);
    await expect(cancelled.json()).resolves.toStrictEqual({
      requested: false,
    });
  });

  it("stops at an explicit cancel, keeping what it committed and committing nothing more", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, page } = clientFor(opened);
    let steps = 0;
    const keyed = {
      idempotencyKey: "cancel-me",
      onProgress: () => {
        steps += 1;
      },
    };
    const running = client.stream(api.slow, { title: "Started" }, keyed);
    await until(() => steps >= 2);
    const request = JSON.stringify({
      reference: { name: api.slow.name, kind: "action" },
      input: { title: "Started" },
      idempotencyKey: "cancel-me",
    });
    await expect(page.transport.cancelStream?.(request)).resolves.toStrictEqual(
      { requested: true }
    );
    await expect(failureOf(running)).resolves.toMatchObject({
      code: "function.cancelled",
      category: "operational",
    });
    await expect(titles(client, opened)).resolves.toStrictEqual(["Started"]);
    // Its receipt answers the same key again: cancelled, not run anew.
    await expect(
      failureOf(client.stream(api.slow, { title: "Started" }, keyed))
    ).resolves.toMatchObject({ code: "function.cancelled" });
    await expect(titles(client, opened)).resolves.toStrictEqual(["Started"]);
  });

  it("is cancelled once no page follows it", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    let steps = 0;
    const controller = new AbortController();
    const keyed = {
      idempotencyKey: "left-alone",
      onProgress: () => {
        steps += 1;
      },
    };
    const running = client.stream(
      api.slow,
      { title: "Alone" },
      { ...keyed, signal: controller.signal }
    );
    await until(() => steps >= 1);
    controller.abort();
    await expect(failureOf(running)).resolves.toMatchObject({
      code: "stream.cancelled",
    });
    // Past the wait for a reconnect (`streamIdleCancelMs`), the host
    // cancels it, saying why; attaching again answers that, and runs
    // nothing.
    await scheduler.wait(11_000);
    await expect(
      failureOf(client.stream(api.slow, { title: "Alone" }, keyed))
    ).resolves.toMatchObject({
      code: "function.cancelled",
      details: { reason: "unfollowed" },
    });
    await expect(titles(client, opened)).resolves.toStrictEqual(["Alone"]);
  });

  it("fails on progress its schema refuses, and refuses oversized progress to the handler", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    await expect(
      failureOf(client.stream(api.wrong, {}, { onProgress: ignoreProgress }))
    ).resolves.toMatchObject({ code: "contract.invalid_progress" });
    await expect(
      client.stream(api.huge, {}, { onProgress: ignoreProgress })
    ).resolves.toBe("contract.progress_too_large");
  });

  it("refuses a reference of the wrong mode, by its type and in core", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    // A reference is a name: core, which knows the function, refuses it.
    await expect(
      // @ts-expect-error -- a streaming action isn't a single answer's
      failureOf(client.action(api.draft, { topic: "x" }))
    ).resolves.toMatchObject({ code: "function.mode_mismatch" });
    await expect(
      // @ts-expect-error -- an action that answers once doesn't stream
      failureOf(client.stream(api.echo, {}, { onProgress: ignoreProgress }))
    ).resolves.toMatchObject({ code: "function.mode_mismatch" });
    const reference = { name: api.draft.name, kind: "action" };
    const single = await post(
      opened.app,
      opened.builder,
      "",
      JSON.stringify({ reference, input: { topic: "x" } })
    );
    await expect(single.json()).resolves.toMatchObject({
      result: { ok: false, error: { code: "function.mode_mismatch" } },
    });
    const echo = { ...reference, name: api.echo.name };
    const streamed = await post(
      opened.app,
      opened.builder,
      "/stream",
      JSON.stringify({ reference: echo, input: {}, idempotencyKey: "k" })
    );
    await expect(streamed.text()).resolves.toContain(
      '"code":"function.mode_mismatch"'
    );
  });

  it("refuses a stream sent with a paginated list's window, before it runs", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const key = crypto.randomUUID();
    const reference = { name: api.counts.name, kind: "action" };
    const windowed = await post(
      opened.app,
      opened.builder,
      "/stream",
      JSON.stringify({
        reference,
        input: {},
        idempotencyKey: key,
        window: { extent: 10 },
      })
    );
    // Nothing started under the key: attaching to it finds no invocation.
    const attached = await post(
      opened.app,
      opened.builder,
      "/attach",
      JSON.stringify({ reference, input: {}, idempotencyKey: key })
    );
    const [windowedText, attachedText] = [
      await windowed.text(),
      await attached.text(),
    ];
    expect({
      refused: windowedText.includes('"code":"contract.invalid_request"'),
      ran: [windowedText, attachedText].some((text) =>
        text.includes('"ok":true')
      ),
    }).toStrictEqual({ refused: true, ran: false });
  });
});
