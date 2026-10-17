import { appErrors } from "@grasp-os/shared/apps";
import { screenLimits } from "@grasp-os/shared/screens";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  relayPreviewStream,
  streamRecheckMs,
} from "../src/preview-stream-relay.ts";

// The relay of a preview's streaming action to its page
// (preview-stream-relay.ts), on frames made here: how often it checks the
// person may still have the stream, that a refusal cancels the run before
// it waits on the page, and that a result too large for a screen is
// refused.

/** JSON lines of `frames`, as the invocation's reader sends them. */
const linesOf = (frames: readonly unknown[]): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(
    frames.map((frame) => `${JSON.stringify(frame)}\n`).join("")
  );
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });
};

/** A frame's type and, for a refusal or a failed result, its code. */
const shapeOf = (frame: unknown): unknown => {
  const text = JSON.stringify(frame);
  const code = /"code":"(?<code>[a-z_.]+)"/u.exec(text)?.groups?.code;
  const type =
    typeof frame === "object" && frame !== null && "type" in frame
      ? frame.type
      : undefined;
  return { type, code };
};

const progress = (seq: number) => ({
  type: "progress",
  seq,
  value: { step: seq },
});

describe("a preview stream's relay", () => {
  it("checks before the result, not before every progress frame", async () => {
    const delivered: unknown[] = [];
    let checks = 0;
    relayPreviewStream(
      linesOf([
        ...Array.from({ length: 20 }, (_unused, at) => progress(at + 1)),
        { type: "result", seq: 21, result: { ok: true, value: null } },
      ]),
      {
        deliver: async (frame) => {
          delivered.push(frame);
          return await Promise.resolve(null);
        },
        stillOpen: async () => {
          checks += 1;
          await Promise.resolve();
        },
        cancel: async () => await Promise.resolve(false),
        requestId: "request",
      }
    );
    await vi.waitFor(() => {
      expect(delivered).toHaveLength(21);
    });
    expect(checks).toBe(1);
  });

  it("cancels the run at once when the person may no longer have it, whatever the page does with the refusal", async () => {
    const delivered: unknown[] = [];
    let cancelled = false;
    relayPreviewStream(
      linesOf([{ type: "result", seq: 1, result: { ok: true, value: 1 } }]),
      {
        // A page that never takes the refusal.
        deliver: async (frame) => {
          delivered.push(frame);
          // Never settles.
          return await Promise.withResolvers<null>().promise;
        },
        stillOpen: async () => {
          await Promise.resolve();
          throw appErrors.create("app.preview_outdated");
        },
        cancel: async () => {
          cancelled = true;
          return await Promise.resolve(true);
        },
        requestId: "request",
      }
    );
    await vi.waitFor(() => {
      expect({ cancelled, delivered: delivered.map(shapeOf) }).toStrictEqual({
        cancelled: true,
        delivered: [{ type: "refused", code: "app.preview_outdated" }],
      });
    });
  });

  it("hands on nothing after the timer's check refused, even a check already under way", async () => {
    vi.useFakeTimers();
    const delivered: unknown[] = [];
    const first = Promise.withResolvers<null>();
    let checks = 0;
    relayPreviewStream(
      linesOf([{ type: "result", seq: 1, result: { ok: true, value: 1 } }]),
      {
        deliver: async (frame) => {
          delivered.push(frame);
          return await Promise.resolve(null);
        },
        // The result's check waits; the timer's, meanwhile, refuses.
        stillOpen: async () => {
          checks += 1;
          if (checks === 1) {
            await first.promise;
            return;
          }
          throw appErrors.create("app.preview_outdated");
        },
        cancel: async () => await Promise.resolve(true),
        requestId: "request",
      }
    );
    await vi.waitFor(() => {
      expect(checks).toBe(1);
    });
    await vi.advanceTimersByTimeAsync(streamRecheckMs);
    first.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    expect(delivered.map(shapeOf)).toStrictEqual([
      { type: "refused", code: "app.preview_outdated" },
    ]);
  });

  it("refuses a result larger than a screen takes in one answer", async () => {
    const delivered: unknown[] = [];
    relayPreviewStream(
      linesOf([
        {
          type: "result",
          seq: 1,
          result: { ok: true, value: "x".repeat(screenLimits.answerBytes) },
        },
      ]),
      {
        deliver: async (frame) => {
          delivered.push(frame);
          return await Promise.resolve(null);
        },
        stillOpen: async () => {
          await Promise.resolve();
        },
        cancel: async () => await Promise.resolve(false),
        requestId: "request",
      }
    );
    await vi.waitFor(() => {
      expect(delivered.map(shapeOf)).toStrictEqual([
        { type: "result", code: "screen.answer_too_large" },
      ]);
    });
  });
});
