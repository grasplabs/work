// The life of an action: it runs async work, says that it works, then how it went ("Saved",
// "Could not save"), once to a screen reader, holds that result for duration-hold, then returns to
// rest. Its own `loadingText` is said as the work starts; with none, the catalogue's word is said
// only once the work has run for loading-delay, so quick work says only how it went. A second run
// while it works does nothing; after a failure it runs again at once (the words corrected, the
// connection back); while it shows that it worked it does nothing, so the same work never runs twice
// by accident, unless `runWhileShown` says each run is new work.
//
// A Button runs it for a press whose `onClick` returns a Promise, and shows it; a page uses it for
// work it runs itself, such as a form's submit, and gives the Button its `status`:
//
//   const save = useAction(saveChanges, { successText: saved, errorText: notSaved });
//   <form onSubmit={(event) => { event.preventDefault(); void save.run(new FormData(event.currentTarget)); }}>
//     <Button type="submit" status={save.status} successText={saved}>Save changes</Button>
//   </form>
//
// The error is not swallowed: it is `save.error`, what `run()` resolves with, and what `onError`
// receives, so the page can say why or report it.
"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { useI18n } from "../lib/i18n";
import { durations } from "../lib/tokens.values";
import { announce, announceWork } from "../lib/utils";

/** Where an action is. */
export type ActionStatus = "idle" | "loading" | "success" | "error";

/** The words of an action's life. Each one left out is the catalogue's (`useAction`). */
export interface ActionText {
  /** Said while it works ("Saving"). */
  loadingText?: string;
  /** Shown and said once it worked ("Saved"). */
  successText?: string;
  /** Shown and said when it failed, plainly ("Could not save"). */
  errorText?: string;
}

/** How a run ended: the work's own result, the error it threw, or busy with the run before. */
export type ActionResult<Result> =
  | { ok: true; value: Result }
  | { ok: false; error: unknown }
  | { ok: false; busy: true };

/** The words of each state but rest, with the catalogue's in place of any left out. */
export type ActionStatusLabels = Record<Exclude<ActionStatus, "idle">, string>;

export interface Action<Args extends unknown[], Result> {
  status: ActionStatus;
  /** The words for where it is: the loading, success or error label; undefined at rest. */
  label: string | undefined;
  /** Every state's words, with the catalogue's in place of any left out. */
  labels: ActionStatusLabels;
  /** The error of the last run that failed, until the next run starts. */
  error: unknown;
  /**
   * Runs it, with the work's own arguments. Busy while it works, and while it shows that it worked
   * (unless `runWhileShown`); after a failure it runs again at once.
   */
  run: (...args: Args) => Promise<ActionResult<Result>>;
}

export interface ActionOptions extends ActionText {
  /** Called with the error when the work fails, after the button has said so. */
  onError?: (error: unknown) => void;
  /**
   * Each run is new work (a rename after a rename), so it may run again at once while it shows
   * that it worked.
   * @default false
   */
  runWhileShown?: boolean;
}

/** Clears the timer that brings the result back to rest, if one runs. */
const stop = (timer: RefObject<ReturnType<typeof setTimeout> | null>) => {
  if (timer.current !== null) {
    clearTimeout(timer.current);
  }
};

export const useAction = <Args extends unknown[], Result>(
  work: (...args: Args) => Promise<Result>,
  options: ActionOptions = {}
): Action<Args, Result> => {
  const words = useI18n().action;
  const labels: ActionStatusLabels = {
    loading: options.loadingText ?? words.loading,
    success: options.successText ?? words.success,
    error: options.errorText ?? words.error,
  };
  const [status, setStatus] = useState<ActionStatus>("idle");
  // The last failure, boxed, so "no error" is not a value the work could have thrown.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ends the wait after which work still running is said to be working (announceWork).
  const over = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  // The newest work, words and handler, so a press always runs what the page passed last.
  const own = options.loadingText !== undefined;
  const again = options.runWhileShown ?? false;
  const latest = useRef({ work, labels, own, onError: options.onError, again });
  useEffect(() => {
    latest.current = { work, labels, own, onError: options.onError, again };
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop(timer);
      over.current?.();
    };
  }, []);

  const settle = (result: "success" | "error") => {
    over.current?.();
    announce(latest.current.labels[result]);
    if (!mounted.current) {
      running.current = false;
      return;
    }
    setStatus(result);
    // After a failure the work may be tried again at once (a field with its words corrected); after
    // a success a second press waits out the tick, so the same work never runs twice by accident.
    if (result === "error" || latest.current.again) {
      running.current = false;
    }
    timer.current = setTimeout(() => {
      running.current = false;
      if (mounted.current) {
        setStatus("idle");
      }
    }, durations.hold);
  };

  const run = async (...args: Args): Promise<ActionResult<Result>> => {
    if (running.current) {
      return { busy: true, ok: false };
    }
    running.current = true;
    stop(timer);
    setFailure(null);
    setStatus("loading");
    // The caller's own loading words at once; the catalogue's only for work that runs long.
    over.current = announceWork(
      latest.current.labels.loading,
      latest.current.own
    );
    try {
      const value = await latest.current.work(...args);
      settle("success");
      return { ok: true, value };
    } catch (error) {
      if (mounted.current) {
        setFailure({ error });
      }
      settle("error");
      latest.current.onError?.(error);
      return { error, ok: false };
    }
  };

  return {
    status,
    label: status === "idle" ? undefined : labels[status],
    labels,
    error: failure?.error,
    run,
  };
};
