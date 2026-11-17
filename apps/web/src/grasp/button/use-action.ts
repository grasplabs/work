// useAction: the life of an action, for a Button. It runs an async function, shows that it is
// working, then says how it went ("Saved", "Could not save") on the button and to a screen reader,
// and returns the button to rest after a moment. A second press while it works does nothing.
//
//   const save = useAction(saveChanges, { done: "Saved", failed: "Could not save" });
//   <Button variant="ink" {...save.props}>Save changes</Button>
//
// The words are required: a control never does its work in silence, and a failure says plainly
// what did not happen. The error itself is not swallowed: it is `save.error`, what `run()`
// resolves with, and what `onError` receives, so the page can say why or report it.
//
// In a form, run it from the form's submit and give the button the state only:
//
//   <form onSubmit={(event) => { event.preventDefault(); save.run(new FormData(event.currentTarget)); }}>
//     <Button type="submit" variant="ink" {...save.status}>Save changes</Button>
//   </form>
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import { useEffect, useRef, useState } from "react";

import { ms } from "../tokens/tokens.values";
import type { ActionState } from "./button";

export interface ActionWords {
  /** Words while it works ("Saving"). Leave it out to keep the button's own words. */
  working?: string;
  /** Words once it worked, said with a tick ("Saved"). */
  done: string;
  /** Words when it failed, said plainly ("Could not save"). */
  failed: string;
  /** Called with the error when the work fails, after the button has said so. */
  onError?: (error: unknown) => void;
}

/** How a run ended: the work's own result, or the error it threw. */
export type ActionResult<Result> =
  | { ok: true; value: Result }
  | { ok: false; error: unknown }
  | { ok: false; busy: true };

/** The state and words a Button needs to show the life of an action. */
export interface ActionStatus {
  /** Where the action is, as a Button's `status` takes it. */
  status: ActionState;
  /** @deprecated Use `status`. */
  state: ActionState;
  workingLabel?: string;
  doneLabel: string;
  failedLabel: string;
}

/** Spread on a Button that runs the work when pressed: the status, a click and `type="button"`. */
export interface ActionButtonProps extends ActionStatus {
  type: "button";
  onClick: () => Promise<void>;
}

export interface Action<Args extends unknown[], Result> {
  /** Where the action is now. */
  state: ActionState;
  /** The error of the last run that failed, until the next run starts. */
  error: unknown;
  /**
   * Run it yourself, with the work's own arguments (from a form's submit, a shortcut). Ignored
   * while it works or shows its result.
   */
  run: (...args: Args) => Promise<ActionResult<Result>>;
  /** For a Button that is not the trigger (a form's submit button): the state and the words. */
  status: ActionStatus;
  /**
   * For the Button that is the trigger. Only when the work takes no arguments: with arguments,
   * call `run` yourself.
   */
  props: Args extends [] ? ActionButtonProps : never;
}

export const useAction = <Args extends unknown[], Result>(
  work: (...args: Args) => Promise<Result>,
  words: ActionWords
): Action<Args, Result> => {
  const [state, setState] = useState<ActionState>("idle");
  // The last failure, boxed, so "no error" is not a value the work could have thrown.
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const running = useRef(false);
  // 0 while no result is shown.
  const timer = useRef(0);
  const mounted = useRef(true);
  // The newest `work` and words, so a press always runs what the page passed last.
  const latest = useRef({ work, words });
  useEffect(() => {
    latest.current = { work, words };
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const settle = (result: "done" | "failed") => {
    if (!mounted.current) {
      running.current = false;
      return;
    }
    setState(result);
    timer.current = window.setTimeout(() => {
      running.current = false;
      if (mounted.current) {
        setState("idle");
      }
    }, ms.durationHold);
  };

  const run = async (...args: Args): Promise<ActionResult<Result>> => {
    // Busy from the press until the result has been shown: one action at a time.
    if (running.current) {
      return { busy: true, ok: false };
    }
    running.current = true;
    clearTimeout(timer.current);
    setFailure(null);
    setState("working");
    try {
      const value = await latest.current.work(...args);
      settle("done");
      return { ok: true, value };
    } catch (error) {
      if (mounted.current) {
        setFailure({ error });
      }
      settle("failed");
      latest.current.words.onError?.(error);
      return { error, ok: false };
    }
  };

  const status: ActionStatus = {
    status: state,
    state,
    workingLabel: words.working,
    doneLabel: words.done,
    failedLabel: words.failed,
  };
  // `props` is typed `never` unless the work takes no arguments, so this runs only with none.
  const runBare: () => Promise<ActionResult<Result>> = run;
  const props: ActionButtonProps = {
    ...status,
    type: "button",
    // The work's Promise goes back to UI SDK's Button, which keeps the button pending until it
    // settles, so an agent's press waits for the result. A failure rejects with the failure words,
    // so the agent hears "Could not save" instead of a press that seemed to work.
    onClick: async () => {
      const result = await runBare();
      if (!result.ok && !("busy" in result)) {
        throw new Error(latest.current.words.failed);
      }
    },
  };

  return {
    state,
    error: failure?.error,
    run,
    status,
    // SAFETY: the same props whatever the work takes; the type alone hides them when it takes arguments.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    props: props as Action<Args, Result>["props"],
  };
};
