import { useRouter } from "@tanstack/react-router";
import { useRef } from "react";

import type { Session } from "../core.ts";
import { useCoreAction } from "../use-core-action.ts";

// A setting core keeps whole (its `saveSetting` replaces the row, so a
// save names every field), changed a few fields at a time from one page:
// a switch here, a dialog's fields there. Every change goes through this
// one queue, one after the other, and each is laid over what core keeps
// as its turn comes (read again just before it is sent), never over the
// page as it was read or over what this page sent last: a change made
// while another saves, or from another part of the page, writes nothing
// stale back over it. The page reads again after every save.

export const useQueuedSave = <T extends object>(
  read: (session: Session) => Promise<T>,
  send: (session: Session, next: T) => Promise<unknown>
) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * Saves `change` in its turn; true once core kept it. Why it wasn't goes
   * to `report` when given (a dialog saying it), else to `failure`.
   */
  const save = async (
    change: Partial<T>,
    report?: (reason: string) => void
  ): Promise<boolean> => {
    const before = queue.current;
    const mine = (async () => {
      await before;
      const done = await run(async (session) => {
        await send(session, { ...(await read(session)), ...change });
        return true;
      }, report);
      await router.invalidate({ sync: true });
      return done === true;
    })();
    queue.current = mine;
    return await mine;
  };
  return { busy, failure, save };
};
