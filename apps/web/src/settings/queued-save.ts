import { useRouter } from "@tanstack/react-router";
import { useRef } from "react";

import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";

// Settings saved whole, a field at a time, as each is changed: every
// change is laid over the last one sent (not over the page as it was
// read, which a save still on its way hasn't reached yet), and they go to
// core one after the other, so a field changed while another saves loses
// nothing. Once one is refused, the next starts again from what core
// keeps, which the page reads again after every save.

export const useQueuedSave = <T extends object>(
  saved: T,
  send: (session: Session, next: T) => Promise<unknown>
) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const latest = useRef<T | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const save = (change: Partial<T>): void => {
    const next = { ...(latest.current ?? saved), ...change };
    latest.current = next;
    const before = queue.current;
    queue.current = (async () => {
      await before;
      const done = await run(async (session) => {
        await send(session, next);
        return true;
      });
      if (done === undefined) {
        latest.current = null;
      }
      await router.invalidate({ sync: true });
    })();
  };
  return { busy, failure, save };
};
