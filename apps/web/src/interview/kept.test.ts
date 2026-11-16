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

/** The page a save named, by its id. */
const pageOf = (sent: Sent | undefined): unknown => {
  const page = sent?.body.page;
  return typeof page === "object" && page !== null
    ? Reflect.get(page, "id")
    : undefined;
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
      first: { version: first?.body.version, page: first?.body.page },
      last: {
        version: last?.body.version,
        page: last?.body.page,
        keepalive: last?.keepalive,
        removed: JSON.stringify(last?.body.progress).includes('"removed":true'),
      },
    }).toStrictEqual({
      sent: 2,
      first: { version: 3, page: { id: pageOf(first), save: 1 } },
      last: {
        version: 3,
        page: { id: pageOf(first), save: 2 },
        keepalive: true,
        removed: true,
      },
    });
  });

  it("sends a change made after a save whose answer was lost, as the page goes, and its next save, on from that save", async () => {
    vi.useFakeTimers();
    const sent: Sent[] = [];
    // Core takes the first save, but its answer is lost on the way.
    let calls = 0;
    const { promise: never } = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
      sent.push({ body: bodyOf(init), keepalive: init.keepalive === true });
      calls += 1;
      if (calls === 1) {
        throw new TypeError("Failed to fetch");
      }
      return await never;
    });
    holdInterview({ secret: "s".repeat(43), version: 3, progress: said });

    update((now) => ({ ...now, phase: "readback" }));
    await vi.advanceTimersByTimeAsync(1000);
    // Their line removed before it is tried again; then it is, and the
    // page goes while that one is on its way.
    update((now) => withoutLine(now, 1));
    await vi.advanceTimersByTimeAsync(5000);
    window.dispatchEvent(new Event("pagehide"));

    const [lost, again, closing] = sent;
    expect({
      sent: sent.length,
      again: { version: again?.body.version, page: again?.body.page },
      closing: {
        version: closing?.body.version,
        page: closing?.body.page,
        removed: JSON.stringify(closing?.body.progress).includes(
          '"removed":true'
        ),
      },
    }).toStrictEqual({
      sent: 3,
      again: { version: 3, page: { id: pageOf(lost), save: 2 } },
      closing: {
        version: 3,
        page: { id: pageOf(lost), save: 3 },
        removed: true,
      },
    });
  });

  it("goes on from the save it sent as it went, once the page is brought back from the back/forward cache", async () => {
    vi.useFakeTimers();
    const sent: Sent[] = [];
    // Nothing core answers reaches the page: the save it sends as it goes
    // lands, and the page never hears of it.
    const { promise: never } = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", async (_path: string, init: RequestInit) => {
      sent.push({ body: bodyOf(init), keepalive: init.keepalive === true });
      return await never;
    });
    holdInterview({ secret: "s".repeat(43), version: 3, progress: said });

    update((now) => withoutLine(now, 1));
    window.dispatchEvent(new Event("pagehide"));
    // Back from the cache: what they change next is saved after it.
    window.dispatchEvent(new Event("pageshow"));
    update((now) => ({ ...now, phase: "readback" }));
    await vi.advanceTimersByTimeAsync(1000);

    const [went, next] = sent;
    expect({
      went: { keepalive: went?.keepalive, page: went?.body.page },
      next: { version: next?.body.version, page: next?.body.page },
    }).toStrictEqual({
      went: { keepalive: true, page: { id: pageOf(went), save: 1 } },
      next: { version: 3, page: { id: pageOf(went), save: 2 } },
    });
  });
});
