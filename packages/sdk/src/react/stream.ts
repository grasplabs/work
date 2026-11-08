import { useEffect, useState, useSyncExternalStore } from "react";

import { clientInternals } from "../client-core.ts";
import type {
  CallArguments,
  GraspClient,
  StreamReference,
  SubmitOptions,
} from "../client-core.ts";
import { clientError, GraspError } from "../client-error.ts";
import type {
  ProgressOf,
  ReturnOf,
  Streaming,
} from "../function-references.ts";
import { useClient } from "./provider.ts";

/**
 * What a streaming action shows while `useStream` follows it (spec
 * 10.7.6): `idle` before its first run; `running` while it runs, and
 * `recovering` while its connection is restored, each with its latest
 * progress (null before the first); then `completed` with its output,
 * `failed` with its error, or `cancelled`, each with its last progress.
 */
type StreamView<Progress, Output> =
  | { readonly status: "idle" }
  | {
      readonly status: "running" | "recovering";
      readonly progress: Progress | null;
    }
  | {
      readonly status: "completed";
      readonly output: Output;
      readonly progress: Progress | null;
    }
  | {
      readonly status: "failed";
      readonly error: GraspError;
      readonly progress: Progress | null;
    }
  | { readonly status: "cancelled"; readonly progress: Progress | null };

/** What `useStream` answers: the view, and how to run and cancel it. */
type StreamHandle<Reference> = StreamView<
  ProgressOf<Reference>,
  ReturnOf<Reference>
> & {
  /**
   * Runs it, once at a time (`stream.active` while a run is under way):
   * resolves with its validated result, or rejects as `client.stream`.
   */
  readonly run: (
    ...args: CallArguments<Reference, SubmitOptions>
  ) => Promise<ReturnOf<Reference>>;
  /**
   * Cancels the run under way for everyone following it; its view then
   * shows `cancelled` (or `completed`, when it finished first).
   */
  readonly cancel: () => Promise<void>;
};

const idle: StreamView<never, never> = Object.freeze({ status: "idle" });

/** One `useStream`'s run and view: one run at a time, its view a snapshot. */
class StreamRun {
  #view: StreamView<unknown, unknown> = idle;
  readonly #listeners = new Set<() => void>();
  #active = false;
  #release: AbortController | undefined;
  #cancel: (() => Promise<void>) | undefined;
  /** Set once the component let go of the run under way (`release`). */
  #left = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly view = (): StreamView<unknown, unknown> => this.#view;

  #show(view: StreamView<unknown, unknown>): void {
    this.#view = view;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  #progress(): unknown {
    const view = this.#view;
    return view.status === "idle" ? null : view.progress;
  }

  async run(
    client: GraspClient,
    reference: unknown,
    args: unknown,
    options: unknown
  ): Promise<unknown> {
    if (this.#active) {
      throw clientError("stream.active");
    }
    const { signal } =
      typeof options === "object" && options !== null && "signal" in options
        ? options
        : { signal: undefined };
    // Aborted already: nothing starts, as `client.stream` refuses it.
    if (signal instanceof AbortSignal && signal.aborted) {
      throw clientError("submission.cancelled", { sent: false });
    }
    this.#active = true;
    this.#left = false;
    const release = new AbortController();
    this.#release = release;
    const before = this.#view;
    const onAbort = (): void => {
      release.abort();
    };
    if (signal instanceof AbortSignal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // A new run starts clean: nothing of the last one's progress or output.
    this.#show({ status: "running", progress: null });
    try {
      const output = await clientInternals(client).stream(
        reference,
        args,
        {
          ...(typeof options === "object" && options !== null ? options : {}),
          signal: release.signal,
        },
        {
          onStarted: (cancel) => {
            this.#cancel = cancel;
          },
          onRecovering: () => {
            this.#show({ status: "recovering", progress: this.#progress() });
          },
          onAttached: () => {
            this.#show({ status: "running", progress: this.#progress() });
          },
          onProgress: (progress) => {
            const status =
              this.#view.status === "recovering" ? "recovering" : "running";
            this.#show({ status, progress });
          },
        }
      );
      this.#show({ status: "completed", output, progress: this.#progress() });
      return output;
    } catch (error) {
      if (!this.#left && error instanceof GraspError) {
        this.#show(
          error.code === "function.cancelled"
            ? { status: "cancelled", progress: this.#progress() }
            : { status: "failed", error, progress: this.#progress() }
        );
      } else if (!this.#left) {
        // Not the action's failure (options it can't take, say): nothing
        // ran, so the view is what it was before.
        this.#show(before);
      }
      throw error;
    } finally {
      if (signal instanceof AbortSignal) {
        signal.removeEventListener("abort", onAbort);
      }
      this.#active = false;
      this.#release = undefined;
      this.#cancel = undefined;
    }
  }

  /** Cancels the run under way for everyone following it. */
  async cancel(): Promise<void> {
    await this.#cancel?.();
  }

  /**
   * Stops this component following its run (it unmounted): the run goes
   * on for anyone else following it, and the host cancels it once no one
   * does.
   */
  release(): void {
    if (this.#release !== undefined) {
      this.#left = true;
      this.#release.abort();
    }
  }
}

/**
 * The streaming action `reference` names (spec 10.7.6), for this
 * component: its view (`StreamView`), and a stable `run` and `cancel`.
 *
 * ```tsx
 * const draft = useStream(api.writer.draft);
 * // In a handler: await draft.run({ topic });
 * if (draft.status === "running" || draft.status === "recovering") {
 *   const text = draft.progress?.text ?? "";
 * }
 * ```
 *
 * Unmounting, or switching to another action or client, stops this
 * component following its run, and the view starts again from `idle`;
 * it never becomes background work: the host cancels a run no one
 * follows.
 */
export const useStream = <Reference extends StreamReference>(
  reference: Streaming<Reference>
): StreamHandle<Reference> => {
  const client = useClient();
  // One run per client and action: another of either starts afresh, and
  // the run of the last is let go of (the effect's cleanup below), so it
  // neither shows the last one's view nor blocks this one.
  const [bound, setBound] = useState(() => ({
    client,
    reference,
    stream: new StreamRun(),
  }));
  let current = bound;
  if (bound.client !== client || bound.reference !== reference) {
    current = { client, reference, stream: new StreamRun() };
    setBound(current);
  }
  const { stream } = current;
  const view = useSyncExternalStore(stream.subscribe, stream.view);
  useEffect(
    () => () => {
      stream.release();
    },
    [stream]
  );
  const run = async (
    ...[args, options]: CallArguments<Reference, SubmitOptions>
  ): Promise<ReturnOf<Reference>> => {
    const output = await stream.run(client, reference, args, options);
    // SAFETY: the host validated the output against the reference's
    // declared return, which `Reference` carries as its type.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return output as ReturnOf<Reference>;
  };
  const cancel = async (): Promise<void> => {
    await stream.cancel();
  };
  // SAFETY: the view holds what the host validated against the
  // reference's `stream` and `returns`, which `Reference` carries.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const typed = view as StreamView<ProgressOf<Reference>, ReturnOf<Reference>>;
  return { ...typed, run, cancel };
};
