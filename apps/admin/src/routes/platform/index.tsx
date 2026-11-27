import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useFollowDeploys } from "../../admin/channel-parts.tsx";
import { PageLoading } from "../../admin/failure.tsx";
import { fetchPlatform } from "../../admin/platform-data.ts";
import { PlatformPage } from "../../admin/platform-nav.tsx";
import { PlatformOverview } from "../../admin/platform-overview.tsx";
import type { Live } from "../../admin/platform-overview.tsx";
import { fetchReadiness } from "../../admin/readiness.ts";
import { fetchClientGrid, fetchGridLive } from "../../clients/functions.ts";
import type { LiveStatus } from "../../clients/grid.ts";
import { fetchPlatformSpend } from "../../platform-ai-functions.ts";

/** The live figures of every active company, read once the page shows. */
const readLive = async (): Promise<Record<string, LiveStatus> | "failed"> => {
  try {
    return await fetchGridLive();
  } catch {
    return "failed";
  }
};

/**
 * Every company's own Grasp at once (src/admin/platform-overview.tsx).
 * Shared secrets and what staff did are on Maintenance.
 */
const OverviewPage = () => {
  const { rows, platform, readiness, spend } = Route.useLoaderData();
  const channels = useFollowDeploys(platform.channels);
  const [live, setLive] = useState<Live>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const read = await readLive();
      // A page left before its answer came doesn't take it.
      if (current) {
        setLive(read);
      }
    })();
    return () => {
      current = false;
    };
  }, []);
  return (
    <PlatformPage
      description="Every company runs its own Grasp and follows a channel: Edge, then Beta, then Stable."
      title="Platform"
    >
      <PlatformOverview
        channels={channels}
        history={platform.history}
        live={live}
        readiness={readiness}
        rows={rows}
        spend={spend}
      />
    </PlatformPage>
  );
};

/** Every company's own deployment, and the channels. */
export const Route = createFileRoute("/platform/")({
  loader: async () => {
    // Not awaited: every core is read live. A read that fails shows a
    // line, never the error page.
    const spend = (async () => {
      try {
        return await fetchPlatformSpend();
      } catch {
        return null;
      }
    })();
    // Every company read anew on entering, not the frame's minute-old
    // grid: staff act on their deploys here.
    const [rows, platform, readiness] = await Promise.all([
      fetchClientGrid(),
      fetchPlatform(),
      fetchReadiness(),
    ]);
    return { rows, platform, readiness, spend };
  },
  component: OverviewPage,
  pendingComponent: PageLoading,
});
