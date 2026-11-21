// The page's own toast queue, and the way to make another. A toast shows for toast-duration; one
// with an action shows for toast-duration-action, long enough to read it and reach the action, as
// only a toast that stays has a close button. A `duration` on a toast always wins.
import { createToaster as createQueue } from "@ui-sdk/react/toast";
import type { Toaster, ToastOptions } from "@ui-sdk/react/toast";
import { isValidElement } from "react";
import type { ReactNode } from "react";

import { ms } from "../tokens/tokens.values";

type Options = ToastOptions<ReactNode>;

// UI SDK knows a queue by the object it made, so the region is given that one, kept here.
const originals = new WeakMap<object, Toaster<ReactNode>>();

/** The queue UI SDK made, for a ToastRegion; a queue made elsewhere is its own. */
export const queueOf = (toaster: Toaster<ReactNode>): Toaster<ReactNode> =>
  originals.get(toaster) ?? toaster;

/** Whether a toast's first argument is its options rather than its message. */
const isOptions = (value: unknown): value is Options =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !isValidElement(value);

/** An action's toast stays longer, unless it says how long itself. */
const timedOf = (options: Options): Options =>
  options.action !== undefined && options.duration === undefined
    ? { ...options, duration: ms.toastDurationAction }
    : options;
const timed = (options: Options | undefined): Options | undefined =>
  options === undefined ? undefined : timedOf(options);

/** Shows a toast with one argument or two: the message, or the options, then the options. */
const shown =
  (show: (message: ReactNode | Options, options?: Options) => string) =>
  (message: ReactNode | Options, options?: Options) =>
    options === undefined && isOptions(message)
      ? show(timedOf(message))
      : show(message, timed(options));

/**
 * Makes a queue of toasts, for a second Toaster with its own toasts. Grasp's times are its
 * defaults: `duration` sets the plain one.
 */
export const createToaster = ({
  duration = ms.toastDuration,
}: { duration?: number } = {}): Toaster<ReactNode> => {
  const queue = createQueue({ duration });
  const toast = Object.assign(shown(queue), queue, {
    success: shown(queue.success),
    error: shown(queue.error),
    info: shown(queue.info),
    warning: shown(queue.warning),
    update: (id: string, options: ReactNode | Options) =>
      queue.update(id, isOptions(options) ? timedOf(options) : options),
  });
  originals.set(toast, queue);
  // SAFETY: the queue itself with Grasp's own show functions over UI SDK's, which take the same arguments.
  return toast as Toaster<ReactNode>;
};

/** Shows a toast: `toast("Saved")`, `toast.success(…)`, `toast.promise(…)`, `toast.update(id, …)`. */
export const toast = createToaster();
