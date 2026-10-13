import type {
  RunHistoryEntry,
  RunHistoryPage,
} from "@grasp-os/shared/workflows";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HistoryView } from "./history-view.tsx";
import {
  firstHistory,
  formatDuration,
  historyItems,
  withPage,
} from "./run-history.ts";

// A run's history as its page shows it, read from what it renders: each
// step once with its attempts under it, waits by kind, a compensation,
// what couldn't be read, and failures in the words core gave.

const start = Date.UTC(2026, 9, 13, 9, 0, 0);
const second = 1000;

/** What an entry tells, without where and when: each kind on its own. */
type Told = RunHistoryEntry extends infer Each
  ? Each extends RunHistoryEntry
    ? Omit<Each, "id" | "sequence" | "taskId" | "at">
    : never
  : never;

let sequence = 0;
/** An entry told `at` seconds after the run's start, next in the journal. */
const entry = (
  fields: Told,
  at = 0,
  taskId: string | null = null
): RunHistoryEntry => {
  sequence += 1;
  return {
    ...fields,
    id: `e${sequence}`,
    sequence,
    taskId,
    at: start + at * second,
  };
};

const step = (
  stepId: string,
  state: "started" | "completed" | "retrying",
  attempt: number,
  at: number,
  taskId: string | null = null
) => entry({ kind: "step", stepId, state, attempt }, at, taskId);

const failed = (
  stepId: string,
  attempt: number,
  at: number,
  error: { code: string; message: string },
  taskId: string | null = null
) =>
  entry({ kind: "step", stepId, state: "failed", attempt, error }, at, taskId);

const wait = (
  waitKind: "timer" | "event" | "decision" | "blocked",
  waitId: string,
  state: "opened" | "closed",
  at: number,
  taskId: string | null = null,
  deadline: number | null = null
) => entry({ kind: "wait", waitId, waitKind, state, deadline }, at, taskId);

const entities: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&#x27;": "'",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
};

/** The page's text, as a person reads it: tags gone, spaces collapsed. */
const textOf = (markup: string): string =>
  markup
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(
      /&#x27;|&amp;|&quot;|&lt;|&gt;/gu,
      (found) => entities[found] ?? found
    )
    .replaceAll(/\s+/gu, " ")
    .trim();

const render = (
  entries: readonly RunHistoryEntry[],
  { hasMore = false, busy = false } = {}
): string =>
  renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <HistoryView
        busy={busy}
        entries={entries}
        hasMore={hasMore}
        onMore={() => {}}
      />
    </I18nProvider>
  );

const occurrences = (text: string, part: string): number =>
  text.split(part).length - 1;

describe("a run's history", () => {
  it("shows a step's retries as attempts of that one step, each with how long it took", () => {
    const text = textOf(
      render([
        step("step-4", "started", 1, 0, "send-invoice"),
        step("step-4", "retrying", 1, 2, "send-invoice"),
        step("step-4", "started", 2, 5, "send-invoice"),
        step("step-4", "completed", 2, 6, "send-invoice"),
      ])
    );
    expect({
      once: occurrences(text, "send-invoice"),
      first: text.includes("Attempt 1 Failed, tried again 2 sec"),
      second: text.includes("Attempt 2 Completed 1 sec"),
      whole: text.includes("send-invoice 6 sec"),
    }).toStrictEqual({ once: 1, first: true, second: true, whole: true });
  });

  it("keeps a step one step when its next attempt comes on a later page", () => {
    const first: RunHistoryPage = {
      items: [
        step("step-2", "started", 1, 0, "fetch"),
        step("step-2", "retrying", 1, 1, "fetch"),
      ],
      nextCursor: "2",
      hasMore: true,
    };
    const later: RunHistoryPage = {
      items: [
        step("step-2", "started", 2, 3, "fetch"),
        step("step-2", "completed", 2, 4, "fetch"),
      ],
      nextCursor: null,
      hasMore: false,
    };
    const once = firstHistory("run-a", first);
    const both = withPage(once, { run: "run-a", cursor: "2" }, later);
    // The same page read twice adds nothing twice.
    const again = withPage(both, { run: "run-a", cursor: "2" }, later);
    expect({
      cursors: [once.cursor, both.cursor],
      items: historyItems(again.entries).map((item) =>
        item.type === "step"
          ? item.attempts.map(({ attempt, state }) => `${attempt} ${state}`)
          : item.type
      ),
    }).toStrictEqual({
      cursors: ["2", null],
      items: [["1 retrying", "2 completed"]],
    });
  });

  it("keeps each run's history its own when a page comes for another run", () => {
    const ofA: RunHistoryPage = {
      items: [step("step-1", "started", 1, 0, "fetch")],
      nextCursor: "1",
      hasMore: true,
    };
    const ofB: RunHistoryPage = {
      items: [step("step-1", "started", 1, 0, "charge")],
      nextCursor: "1",
      hasMore: true,
    };
    const laterOfA: RunHistoryPage = {
      items: [step("step-1", "completed", 1, 2, "fetch")],
      nextCursor: null,
      hasMore: false,
    };
    const b = firstHistory("run-b", ofB);
    // Run A's next page, asked for before the page moved on to run B, at
    // the same cursor run B is at now.
    const late = withPage(b, { run: "run-a", cursor: "1" }, laterOfA);
    // Run B's own next page goes on from where run B is.
    const own = withPage(b, { run: "run-b", cursor: "1" }, laterOfA);
    // A page from a cursor run A has moved past changes nothing either.
    const a = withPage(
      firstHistory("run-a", ofA),
      { run: "run-a", cursor: "1" },
      laterOfA
    );
    const stale = withPage(a, { run: "run-a", cursor: "1" }, ofA);
    expect({
      late: late === b,
      own: [own.run, own.cursor, own.entries.length],
      stale: stale === a,
    }).toStrictEqual({ late: true, own: ["run-b", null, 2], stale: true });
  });

  it("offers more while core has more, and not once it has none", () => {
    const entries = [step("step-1", "started", 1, 0, "fetch")];
    const more = render(entries, { hasMore: true });
    const loading = render(entries, { hasMore: true, busy: true });
    const done = render(entries);
    expect({
      more: textOf(more).includes("Load more"),
      loading:
        textOf(loading).includes("Loading…") && loading.includes("disabled"),
      done: textOf(done).includes("Load more"),
    }).toStrictEqual({ more: true, loading: true, done: false });
  });

  it("tells each kind of wait, from when it opened to when it closed", () => {
    const text = textOf(
      render([
        wait("timer", "w1", "opened", 0, null, start + 60 * second),
        wait("timer", "w1", "closed", 60),
        wait("event", "w2", "opened", 61),
        wait("event", "w2", "closed", 64),
        wait("decision", "dec_1", "opened", 65, "approve"),
        wait("decision", "dec_1", "closed", 125, "approve"),
        wait("blocked", "step-9", "opened", 130, "pay"),
      ])
    );
    expect({
      timer: text.includes("Waiting for a set time 1 min"),
      until: text.includes("Until"),
      event: text.includes("Waiting for an event 3 sec"),
      decision: text.includes("Waiting for the decision approve 1 min"),
      blocked: text.includes(
        "A change by pay waits for approval by the person the run acts for Open"
      ),
      open: occurrences(text, "Open"),
    }).toStrictEqual({
      timer: true,
      until: true,
      event: true,
      decision: true,
      blocked: true,
      open: 1,
    });
  });

  it("names a step the review doesn't show by its number in the run", () => {
    const text = textOf(
      render([
        step("step-3", "started", 1, 0),
        step("step-3", "completed", 1, 1),
      ])
    );
    expect(text.startsWith("Step 3")).toBeTruthy();
  });

  it("shows a failure's message where core gives one, and words of its own where core gives none", () => {
    const told = textOf(
      render([
        step("step-5", "started", 1, 0, "charge"),
        failed(
          "step-5",
          1,
          1,
          {
            code: "billing.card_declined",
            message: "The card ending 4242 was declined.",
          },
          "charge"
        ),
      ])
    );
    const generic = textOf(
      render([
        step("step-6", "started", 1, 0),
        failed("step-6", 1, 1, {
          code: "workflow.step_failed",
          message: "A step of the workflow failed.",
        }),
      ])
    );
    const none = textOf(
      render([
        step("step-7", "started", 1, 0),
        failed("step-7", 1, 1, { code: "workflow.step_failed", message: "" }),
      ])
    );
    expect([told, generic, none]).toStrictEqual([
      expect.stringContaining(
        "Attempt 1 Failed 1 sec The card ending 4242 was declined. billing.card_declined"
      ),
      expect.stringContaining(
        "A step of the workflow failed. workflow.step_failed"
      ),
      expect.stringContaining("This step failed. workflow.step_failed"),
    ]);
  });

  it("tells what couldn't be read by its place, and reads on after it", () => {
    const unreadable = entry({ kind: "unreadable" }, 1);
    const text = textOf(
      render([
        step("step-1", "started", 1, 0, "fetch"),
        unreadable,
        step("step-1", "completed", 1, 2, "fetch"),
        entry({ kind: "lifecycle", status: "completed" }, 3),
      ])
    );
    expect({
      unreadable: text.includes(`Entry ${unreadable.sequence} can't be read.`),
      after: text.includes("Completed"),
    }).toStrictEqual({ unreadable: true, after: true });
  });

  it("tells a compensation and why the run undoes its changes", () => {
    const text = textOf(
      render([
        entry(
          {
            kind: "lifecycle",
            status: "compensating",
            cause: "failure",
            activity: "running",
          },
          0
        ),
        entry(
          {
            kind: "compensation",
            stepId: "step-2",
            state: "started",
            attempt: 1,
          },
          1,
          "reserve"
        ),
        entry(
          {
            kind: "compensation",
            stepId: "step-2",
            state: "completed",
            attempt: 1,
          },
          3,
          "reserve"
        ),
      ])
    );
    expect({
      cause: text.includes("Undoing its changes after a failure"),
      undo: text.includes("Undoing reserve 2 sec"),
    }).toStrictEqual({ cause: true, undo: true });
  });

  it("says when nothing is recorded", () => {
    expect(textOf(render([]))).toBe("Nothing is recorded for this run.");
  });
});

describe(formatDuration, () => {
  it("writes a length of time in its largest whole unit", () => {
    expect(
      [350, 2500, 3 * 60 * second, 2 * 3600 * second, 4 * 86_400 * second].map(
        (ms) => formatDuration(ms, "en")
      )
    ).toStrictEqual(["350 ms", "2.5 sec", "3 min", "2 hr", "4 days"]);
  });
});
