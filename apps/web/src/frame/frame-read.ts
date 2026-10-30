import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { frameReadMs } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { useCore } from "../use-core.ts";

/** Every frame read shown now, each told to read again. */
const readers = new Set<() => void>();

/**
 * Has every frame read read again now: for a page whose own read changed
 * what the frame shows, with no change for the router to read again after
 * (the dashboard marks the failures it shows read, and the nav's count
 * goes with them).
 */
export const frameChanged = (): void => {
  for (const reader of readers) {
    reader();
  }
};

/**
 * What the frame reads for itself beside every page (the sidebar's counts,
 * the chat dock's models): read once it is shown; again after a change on
 * a page (the router reads that page again, its address unchanged), or
 * when a page's own read changed it ({@link frameChanged}); and on
 * the way to another page once what was read is older than
 * {@link frameReadMs}, for what others changed meanwhile. Not on every
 * click: a page of its own reads what it shows. Nothing is read while
 * `shown` is false; what was read stays, and it is read again once shown.
 * `readAgain` forgets what was read and reads it now, as after core was
 * out of reach. Only the latest read's answer is kept, and none once the
 * frame is gone. `read` must be the same function on every render (one
 * outside the component).
 */
export const useFrameRead = <T>(
  read: (core: CoreConnection, signal: AbortSignal) => Promise<T>,
  shown = true
): { value: T | undefined; readAgain: () => void } => {
  const router = useRouter();
  const core = useCore();
  const [value, setValue] = useState<T>();
  // The read the effect guards, for `readAgain`; none while nothing reads.
  const again = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!shown) {
      // Nothing reads while hidden, so there is nothing to read again.
      return () => {
        again.current = null;
      };
    }
    const left = new AbortController();
    let latest = 0;
    let readAt = 0;
    const readNow = async (): Promise<void> => {
      latest += 1;
      const mine = latest;
      readAt = Date.now();
      const answer = await read(core, left.signal);
      if (mine === latest && !left.signal.aborted) {
        setValue(answer);
      }
    };
    void readNow();
    again.current = () => {
      setValue(undefined);
      void readNow();
    };
    const told = (): void => {
      void readNow();
    };
    readers.add(told);
    // Not when only the search changes, as a filter typed into does.
    const unsubscribe = router.subscribe(
      "onResolved",
      ({ pathChanged, hrefChanged }) => {
        const changed = !hrefChanged;
        const old = pathChanged && Date.now() - readAt >= frameReadMs;
        if (changed || old) {
          void readNow();
        }
      }
    );
    return () => {
      // Nothing read after this is shown.
      left.abort();
      unsubscribe();
      readers.delete(told);
      again.current = null;
    };
  }, [router, core, read, shown]);
  return {
    value,
    readAgain: () => {
      again.current?.();
    },
  };
};
