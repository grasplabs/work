import { createFileRoute, notFound } from "@tanstack/react-router";

import type { CoreReach } from "../core-connection.ts";
import { PageFailed, useCoreReach } from "../frame/page-failed.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Button } from "../grasp/button/index.ts";

// Local check of the failed page in the App shell's card (frame/
// page-failed.tsx), each state forced: `?reach=checking`, `unreachable` or
// `reachable`, else the tab's own. Not product UI: builds in production
// mode answer not found, as /kit does.

const reaches = new Set<string>(["checking", "reachable", "unreachable"]);

const isReach = (value: unknown): value is CoreReach =>
  typeof value === "string" && reaches.has(value);

const KitFailed = () => {
  const { reach } = Route.useSearch();
  const live = useCoreReach();
  return (
    <>
      <SiteHeader
        crumbs={[{ label: "Kit" }, { label: "A page that failed" }]}
      />
      <PageFailed
        onRetry={async () => {
          await Promise.resolve();
          throw new Error("Still failing, as asked.");
        }}
        reach={reach ?? live}
        reason="Something went wrong. Reference: 7f3a21c9-4e0b-4d2a-9c1e-2b5d8a6f0c13"
        title="This page didn't load"
        wayOn={<Button variant="ghost">Go to Chat</Button>}
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/kit-failed")({
  validateSearch: (search: Record<string, unknown>): { reach?: CoreReach } =>
    isReach(search.reach) ? { reach: search.reach } : {},
  beforeLoad: () => {
    if (import.meta.env.MODE === "production") {
      throw notFound();
    }
  },
  component: KitFailed,
});
