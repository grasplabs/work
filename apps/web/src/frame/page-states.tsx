import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { SearchXIcon, TriangleAlertIcon } from "lucide-react";
import { use } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { InFrame } from "./in-frame.ts";
import { SiteHeader } from "./site-header.tsx";
import type { Crumb } from "./site-header.tsx";

// How every page finds nothing, fails and loads, the same on each: the
// prototype's not-found pattern (an empty state under the page's crumbs,
// "It may have been renamed or removed."), the error with core's reason
// and its request ID and a way to try again, and skeletons while a slow
// read comes. Inside the frame each keeps the site header, and with it the
// way to the sidebar on a phone; outside it (core out of reach, a page
// such as sign-in) the state fills the window on its own.

/** The page's place: in the frame's <main> under its header, or a window of its own. */
const Place = ({
  crumbs,
  children,
}: {
  crumbs: readonly Crumb[];
  children: ReactNode;
}) =>
  use(InFrame) ? (
    <>
      <SiteHeader crumbs={crumbs} />
      <div className="flex flex-1 flex-col">{children}</div>
    </>
  ) : (
    <main className="flex min-h-svh flex-col">{children}</main>
  );

/** Not found, in a page that keeps its own frame, such as Knowledge with its sidebar. */
export const NotFoundState = ({ title }: { title?: string }) => {
  const { t } = useLingui();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>
          <h1>{title ?? t`Not found`}</h1>
        </EmptyTitle>
        <EmptyDescription>
          <Trans>It may have been renamed or removed.</Trans>
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};

/**
 * What a page shows when what it names isn't there: an unknown address, or
 * an App, collection or workflow that was renamed or removed. `crumbs` lead
 * to it, ending in the page; `title` says what wasn't found.
 */
export const NotFound = ({
  crumbs,
  title,
}: {
  crumbs?: readonly Crumb[];
  title?: string;
}) => {
  const { t } = useLingui();
  return (
    <Place crumbs={crumbs ?? [{ label: t`Not found` }]}>
      <NotFoundState title={title} />
    </Place>
  );
};

/** Asks for the page again: its loaders read from core once more. */
const TryAgain = () => {
  const router = useRouter();
  const trying = useRouterState({ select: (state) => state.isLoading });
  const { t } = useLingui();
  return (
    <Button
      disabled={trying}
      onClick={() => {
        void router.invalidate();
      }}
      variant="outline"
    >
      {trying ? t`Trying again…` : t`Try again`}
    </Button>
  );
};

/** The error, in a page that keeps its own frame, such as Knowledge with its sidebar. */
export const ErrorState = ({ reason }: { reason: string | undefined }) => {
  const { t } = useLingui();
  const title = t`This page didn't load`;
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon />
        </EmptyMedia>
        <EmptyTitle>
          <h1>{title}</h1>
        </EmptyTitle>
        <EmptyDescription>
          <ErrorText>{reason}</ErrorText>
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <TryAgain />
      </EmptyContent>
    </Empty>
  );
};

/**
 * What a page shows in place of itself when it didn't load: `reason` says
 * why, with the request ID to quote where there is one, and the page can
 * be asked for again.
 */
export const PageError = ({
  crumbs,
  reason,
}: {
  crumbs?: readonly Crumb[];
  reason: string | undefined;
}) => {
  const { t } = useLingui();
  return (
    <Place crumbs={crumbs ?? [{ label: t`This page didn't load` }]}>
      <ErrorState reason={reason} />
    </Place>
  );
};

/**
 * A page whose own read from core came back without its data: not found
 * when core has no such thing (`notFound` says what), otherwise the error.
 * `crumbs` lead to the page, ending in it.
 */
export const PageNotLoaded = ({
  page,
  crumbs,
  notFound,
}: {
  page: Exclude<Loaded<unknown>, { state: "ready" }>;
  crumbs: readonly Crumb[];
  notFound?: string;
}) => {
  const { i18n, t } = useLingui();
  if (page.state === "missing") {
    return (
      <NotFound
        crumbs={[...crumbs.slice(0, -1), { label: t`Not found` }]}
        title={notFound}
      />
    );
  }
  return <PageError crumbs={crumbs} reason={notLoadedText(page, i18n)} />;
};

/** `PageNotLoaded` in a page that keeps its own frame, such as Knowledge with its sidebar. */
export const NotLoadedState = ({
  page,
  notFound,
}: {
  page: Exclude<Loaded<unknown>, { state: "ready" }>;
  notFound?: string;
}) => {
  const { i18n } = useLingui();
  return page.state === "missing" ? (
    <NotFoundState title={notFound} />
  ) : (
    <ErrorState reason={notLoadedText(page, i18n)} />
  );
};

/** Skeleton lines where a list or text will be, announced once as loading. */
export const LoadingLines = ({ lines = 3 }: { lines?: number }) => {
  const { t } = useLingui();
  return (
    <output
      aria-busy="true"
      aria-label={t`Loading…`}
      className="flex w-full flex-col gap-2"
    >
      {Array.from({ length: lines }, (_, line) => (
        <Skeleton
          className={line === lines - 1 ? "h-4 w-2/3" : "h-4 w-full"}
          key={line}
        />
      ))}
    </output>
  );
};

/**
 * What a page in the frame shows while a slow read comes: the header and
 * the page's usual layout (a heading, a line under it, then its content)
 * as skeletons. Each page under the shell names it as its
 * `pendingComponent`; the shell itself has none, so while it asks who is
 * in again after core was out of reach, what it showed stays.
 */
export const PageLoading = () => (
  <>
    <SiteHeader crumbs={[]} />
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-7">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <LoadingLines lines={4} />
    </div>
  </>
);
