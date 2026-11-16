// @vitest-environment happy-dom
import type { InterviewProgress } from "@grasp-os/shared/interview-links";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { holdInterview, keepNow, releaseInterview, update } from "./kept.ts";
import { freshProgress, withoutLine } from "./progress.ts";

// What the interview page keeps in core (kept.ts), against core's route
// faked as `fetch`: a change made while a save is on its way is never lost
// when the page goes, whether or not that save landed.

/** What the page sent core, as JSON, and whether it was kept alive. */
interface Sent {
  readonly body: Record<string, unknown>;
  readonly keepalive: boolean;
}

/** A request's JSON body, as an object. */
const bodyOf = (init: RequestInit): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(
    typeof init.body === "string" ? init.body : "{}"
  );
  return typeof parsed === "object" && parsed !== null
    ? Object.fromEntries(Object.entries(parsed))
    : {};
};

/** An interview with one line of theirs, to remove. */
const said: InterviewProgress = {
  ...freshProgress,
  person: "progress",
  told: true,
  mode: "type",
  lines: [
    { from: "stephen", text: "What starts one?" },
    { from: "person", text: "A ticket from Ria.", typed: true },
  ],
};

describe("what the interview page keeps", () => {
  afterEach(() => {
    releaseInterview();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends a change made while a save is on its way, as the page goes, on from that save", async () => {
    vi.useFakeTimers();
    const sent: Sent[] = [];
    // Core takes the first save, but its answer never reaches the page.
    const { promise: never } = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
      sent.push({ body: bodyOf(init), keepalive: init.keepalive === true });
      return await never;
    });
    holdInterview({ secret: "s".repeat(43), version: 3, progress: said });

    update((now) => ({ ...now, phase: "readback" }));
    await vi.advanceTimersByTimeAsync(1000);
    // Their line removed while that save is on its way, kept at once.
    update((now) => withoutLine(now, 1));
    keepNow();
    window.dispatchEvent(new Event("pagehide"));

    const [first, last] = sent;
    expect({
      sent: sent.length,
      first: { version: first?.body.version, named: typeof first?.body.save },
      last: {
        version: last?.body.version,
        after: last?.body.after,
        keepalive: last?.keepalive,
        removed: JSON.stringify(last?.body.progress).includes('"removed":true'),
      },
    }).toStrictEqual({
      sent: 2,
      first: { version: 3, named: "string" },
      last: {
        version: 3,
        after: first?.body.save,
        keepalive: true,
        removed: true,
      },
    });
  });
});
