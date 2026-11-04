import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { Session } from "../core.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// A read of one App for a part of its settings (app-settings.tsx), made
// when that part is shown rather than by the route: a section never
// opened never reads. Read again when the router reads the page again at
// the same address (`router.invalidate()`, which the changes made in a
// section call), so a change shows as it does on a loader's page. Only
// the latest read's answer is kept, and none once the section is gone; a
// re-read that fails leaves the last good answer in place.

/**
 * What `read` answers for App `app`; undefined while it comes. `read` must
 * be the same function on every render (one outside the component).
 */
export const useAppRead = <T>(
  app: string,
  read: (session: Session, app: string) => Promise<T>
): Loaded<T> | undefined => {
  const core = useCore();
  const router = useRouter();
  const [value, setValue] = useState<{ app: string; read: Loaded<T> }>();
  useEffect(() => {
    let latest = 0;
    let gone = false;
    const readNow = async (): Promise<void> => {
      latest += 1;
      const mine = latest;
      const answer = await loadFromCore(
        core,
        async (session) => await read(session, app)
      );
      if (mine === latest && !gone) {
        // A re-read that fails keeps what was read before, so a form
        // being typed in stays; a first read that fails says why.
        setValue((before) =>
          answer.state !== "ready" &&
          before?.app === app &&
          before.read.state === "ready"
            ? before
            : { app, read: answer }
        );
      }
    };
    void readNow();
    const unsubscribe = router.subscribe("onResolved", ({ hrefChanged }) => {
      if (!hrefChanged) {
        void readNow();
      }
    });
    return () => {
      gone = true;
      unsubscribe();
    };
  }, [core, router, app, read]);
  // Another App's answer is never this one's.
  return value?.app === app ? value.read : undefined;
};
