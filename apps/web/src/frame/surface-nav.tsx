import type { SidebarApp } from "@grasp-os/shared/pages";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";

// The Apps' sidebar surfaces (spec 34.1), which the shell's sidebar shows
// as a group of their own (grasp/frame/grasp-sidebar.tsx): each App that
// declares any, its entries under it. Listing them opens nothing. Read once
// as the sidebar shows; none while core doesn't answer.

/** The Apps with sidebar entries, as core lists them for the person. */
export const useSidebarApps = (core: CoreConnection): SidebarApp[] => {
  const [apps, setApps] = useState<SidebarApp[]>([]);
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const found = await loadFromCore(
        core,
        async (session) => await session.pages.sidebar(),
        left.signal
      );
      if (!left.signal.aborted && found.state === "ready") {
        setApps(found.data);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);
  return apps;
};
