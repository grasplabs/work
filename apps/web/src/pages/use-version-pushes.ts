import { useEffect, useState } from "react";

import { useCore } from "../use-core.ts";
import { followAppVersion } from "./tab-link.ts";

// What the page heard of `apps`' versions (spec 11.5): core pushes each
// App's version at once and again whenever another is committed, made
// current or proposed, on the tab's one subscription its frames share. A
// preview that found nothing to show keys its next try on the count, so
// a version committed from another tab brings the App back, with no
// timer asking.

/** Each of `apps`' version pushes counted since the page followed it, by App. */
export const useVersionPushes = (
  apps: readonly string[]
): Readonly<Record<string, number>> => {
  const core = useCore();
  const [pushes, setPushes] = useState<Readonly<Record<string, number>>>({});
  // One key for the list, so a list equal to the last follows on.
  const followed = [...new Set(apps)].toSorted().join(" ");
  useEffect(() => {
    const named = followed === "" ? [] : followed.split(" ");
    const stops = named.map((app) =>
      followAppVersion(core, app, (push) => {
        if (push.type === "current") {
          setPushes((before) => ({ ...before, [app]: (before[app] ?? 0) + 1 }));
        }
      })
    );
    return () => {
      for (const stop of stops) {
        stop();
      }
    };
  }, [core, followed]);
  return pushes;
};
