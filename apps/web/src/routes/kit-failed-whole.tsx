import { createFileRoute, notFound } from "@tanstack/react-router";

import type { CoreReach } from "../core-connection.ts";
import { PageFailed } from "../frame/page-failed.tsx";

// Local check of the failed page as the whole window, as when the shell
// itself could not load (frame/page-failed.tsx), each state forced:
// `?reach=checking`, `unreachable` (the default) or `reachable`. Not
// product UI: builds in production mode answer not found, as /kit does.

const reaches = new Set<string>(["checking", "reachable", "unreachable"]);

const isReach = (value: unknown): value is CoreReach =>
  typeof value === "string" && reaches.has(value);

const KitFailedWhole = () => {
  const { reach } = Route.useSearch();
  return (
    <PageFailed
      onRetry={async () => {
        await Promise.resolve();
        throw new Error("Still failing, as asked.");
      }}
      reach={reach ?? "unreachable"}
      reason="Grasp can't be reached right now. Try again in a moment."
      title="This page didn't load"
      whole
    />
  );
};

export const Route = createFileRoute("/kit-failed-whole")({
  validateSearch: (search: Record<string, unknown>): { reach?: CoreReach } =>
    isReach(search.reach) ? { reach: search.reach } : {},
  beforeLoad: () => {
    if (import.meta.env.MODE === "production") {
      throw notFound();
    }
  },
  component: KitFailedWhole,
});
