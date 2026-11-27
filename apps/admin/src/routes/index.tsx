import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Suspense } from "react";

import { AdminsUnread } from "../admin/admins.tsx";
import { HomeBody, NewOrganization } from "../admin/home.tsx";
import { freshMs } from "../admin/org-reads.ts";
import { AdminPage } from "../admin/page.tsx";
import type { PlatformSpend } from "../admin/platform-spend-sums.ts";
import { useSettled } from "../admin/settled.tsx";
import type { Deferred } from "../admin/settled.tsx";
import type { ClientSummary } from "../clients/summary.ts";
import { LoadingLines } from "../frame/page.tsx";
import { fetchPlatformSpend } from "../platform-ai-functions.ts";

const root = getRouteApi("__root__");

/** What Grasp's AI cost on its keys, or null when it couldn't be read: Home never fails for it. */
const spendOrNone = async (): Promise<PlatformSpend | null> => {
  try {
    return await fetchPlatformSpend();
  } catch {
    return null;
  }
};

/** Home's body once the summaries are in; what Grasp's AI cost fills in apart. */
const Settled = ({
  summaries,
  spend,
}: {
  summaries: Deferred<ClientSummary[] | null>;
  spend: Deferred<PlatformSpend | null> | undefined;
}) => {
  const read = useSettled(summaries);
  return read === null ? (
    <AdminsUnread />
  ) : (
    <HomeBody spend={spend} summaries={read} />
  );
};

const Home = () => {
  const { summaries } = root.useLoaderData();
  const { spend } = Route.useLoaderData();
  return (
    <AdminPage
      action={<NewOrganization />}
      description="What needs Grasp today, and how every organization is doing."
      overview
      title="Home"
    >
      <Suspense fallback={<LoadingLines lines={8} />}>
        <Settled spend={spend} summaries={summaries} />
      </Suspense>
    </AdminPage>
  );
};

/**
 * The admin's Home: how Grasp is doing, what needs it, and every
 * organization, from the summaries the frame reads (src/routes/__root.tsx:
 * counts and dates, which no core audits) and what Grasp's AI cost on its
 * keys, read from every core once Home opens. No organization's snapshot
 * is read here. A preload (a link pointed at) reads nothing.
 */
export const Route = createFileRoute("/")({
  loader: ({ preload }) => ({
    spend: preload ? undefined : spendOrNone(),
  }),
  staleTime: freshMs,
  preloadStaleTime: 0,
  component: Home,
});
