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
// re-read that fails leaves the last good answer in place, saying it
// couldn't be refreshed, with a way to read it again.

/** The live App's tables and the version they're read at: one read for every view of them. */
export const readTables = async (session: Session, app: string) =>
  await session.apps.data.tables(app);

/**
 * A read's answer, and, while it shows what was read before because the
 * latest re-read failed, why that failed and a way to read again.
 */
export type AppRead<T> = Loaded<T> & {
  refresh?: { failure: Loaded<unknown>; retry: () => void };
};

/**
 * What `read` answers for App `app`; undefined while it comes. `read` must
 * be the same function on every render (one outside the component).
 */
export const useAppRead = <T>(
  app: string,
  read: (session: Session, app: string) => Promise<T>
): AppRead<T> | undefined => {
  const core = useCore();
  const router = useRouter();
  const [value, setValue] = useState<{
    app: string;
    read: Loaded<T>;
    /** Why the latest re-read failed, while `read` is the one before. */
    failed?: Loaded<unknown>;
  }>();
  // Read again (Try again) after a re-read failed.
  const [attempt, setAttempt] = useState(0);
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
            ? { ...before, failed: answer }
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `attempt` says when to read again
  }, [core, router, app, read, attempt]);
  // Another App's answer is never this one's.
  if (value?.app !== app) {
    return undefined;
  }
  if (value.failed === undefined) {
    return value.read;
  }
  return {
    ...value.read,
    refresh: {
      failure: value.failed,
      retry: () => {
        // The note goes while it reads, and comes back if it fails again.
        setValue({ app: value.app, read: value.read });
        setAttempt(attempt + 1);
      },
    },
  };
};
