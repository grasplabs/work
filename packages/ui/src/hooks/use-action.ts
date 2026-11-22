// The life of an action: it runs async work, says that it works, then how it went ("Saved",
// "Could not save"), once to a screen reader, holds that result for duration-hold, then returns to
// rest. A second run while it works or shows its result does nothing.
//
// A Button runs it for a press whose `onClick` returns a Promise, and shows it; a page uses it for
// work it runs itself, such as a form's submit, and gives the Button its `status`:
//
//   const save = useAction(saveChanges, { successLabel: saved, errorLabel: notSaved });
//   <form onSubmit={(event) => { event.preventDefault(); void save.run(new FormData(event.currentTarget)); }}>
//     <Button type="submit" status={save.status} successLabel={saved}>Save changes</Button>
//   </form>
//
// The error is not swallowed: it is `save.error`, what `run()` resolves with, and what `onError`
// receives, so the page can say why or report it.
"use client";

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { useI18n } from "../lib/i18n";
import { durations } from "../lib/tokens.values";
import { announce } from "../lib/utils";

/** Where an action is. */
export type ActionStatus = "idle" | "loading" | "success" | "error";

/** The words of an action's life. Each one left out is the catalogue's (`useAction`). */
export interface ActionLabels {
  /** Said while it works ("Saving"). */
  loadingLabel?: string;
  /** Shown and said once it worked ("Saved"). */
  successLabel?: string;
  /** Shown and said when it failed, plainly ("Could not save"). */
  errorLabel?: string;
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
  /** Runs it, with the work's own arguments. Busy while it works or shows its result. */
  run: (...args: Args) => Promise<ActionResult<Result>>;
}

export interface ActionOptions extends ActionLabels {
  /** Called with the error when the work fails, after the button has said so. */
  onError?: (error: unknown) => void;
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
  const words = useI18n().useAction;
  const labels: ActionStatusLabels = {
    loading: options.loadingLabel ?? words.loading,
    success: options.successLabel ?? words.success,
    error: options.errorLabel ?? words.error,
  };
  const [status, setStatus] = useState<ActionStatus>("idle");
  // The last failure, boxed, so "no error" is not a value the work could have thrown.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  // The newest work, words and handler, so a press always runs what the page passed last.
  const latest = useRef({ work, labels, onError: options.onError });
  useEffect(() => {
    latest.current = { work, labels, onError: options.onError };
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop(timer);
    };
  }, []);

  const settle = (result: "success" | "error") => {
    announce(latest.current.labels[result]);
    if (!mounted.current) {
      running.current = false;
      return;
    }
    setStatus(result);
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
    announce(latest.current.labels.loading);
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
