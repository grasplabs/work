import { createFileRoute } from "@tanstack/react-router";

import { Overview } from "../../../admin/overview.tsx";
import {
  fetchClientAiStatus,
  fetchClientSetup,
} from "../../../clients/functions.ts";

const OverviewPage = () => {
  const { setup, aiStatus } = Route.useLoaderData();
  return <Overview aiStatus={aiStatus} setup={setup} />;
};

/** `read`, or null where it fails: a part says so in its place, never the route's error page. */
const orNull = async <T,>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

/**
 * An organization's overview (src/admin/overview.tsx): what comes next,
 * how it is doing, what else needs Grasp, what happened lately, and a
 * way into each section. Its recent history (the admin's own records)
 * and its AI status (asked of its core) aren't awaited: each fills in its
 * own place. Its core isn't asked on a preload: the page loads anew once
 * it is opened.
 */
export const Route = createFileRoute("/organizations/$clientId/")({
  loader: ({ params, preload }) => {
    const data = { clientId: params.clientId };
    return {
      setup: orNull(async () => await fetchClientSetup({ data })),
      aiStatus: preload
        ? Promise.resolve(null)
        : orNull(async () => await fetchClientAiStatus({ data })),
    };
  },
  preloadStaleTime: 0,
  component: OverviewPage,
});
