import { useRouter } from "@tanstack/react-router";
import { useRef } from "react";

import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";

// Settings saved whole, a field at a time, as each is changed: every
// change is laid over the last one sent (not over the page as it was
// read, which a save still on its way hasn't reached yet), and they go to
// core one after the other, so a field changed while another saves loses
// nothing. Every change to them goes through the one queue, a dialog's
// too, or a later change would send what the dialog replaced. Once one is
// refused, the next starts again from what core keeps, which the page
// reads again after every save.

export const useQueuedSave = <T extends object>(
  saved: T,
  send: (session: Session, next: T) => Promise<unknown>
) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const latest = useRef<T | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** Sends `change` once those before it went; whether core took it. `report` says why not, in place of `failure`. */
  const save = async (
    change: Partial<T>,
    report?: (reason: string) => void
  ): Promise<boolean> => {
    const next = { ...(latest.current ?? saved), ...change };
    latest.current = next;
    const before = queue.current;
    const sent = (async () => {
      await before;
      const done = await run(async (session) => {
        await send(session, next);
        return true;
      }, report);
      if (done === undefined) {
        latest.current = null;
      }
      await router.invalidate({ sync: true });
      return done === true;
    })();
    queue.current = sent;
    return await sent;
  };
  return { busy, failure, save };
};
