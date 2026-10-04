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
import type { LucideIcon } from "lucide-react";
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

/**
 * The level of a state's title: `h1` where it stands for the page, lower
 * where it sits under the page's own heading (a settings section's `h3`,
 * under the page's and the section's).
 */
type StateHeading = "h1" | "h2" | "h3";

/** Not found, in a page that keeps its own frame, such as Knowledge with its sidebar. */
export const NotFoundState = ({
  title,
  icon: Icon = SearchXIcon,
  heading: Heading = "h1",
}: {
  title?: string;
  /** What wasn't found, as the sidebar draws it: a workflow's icon, say. */
  icon?: LucideIcon;
  /** Its title's level: the page's own heading unless it sits in a section that has one. */
  heading?: StateHeading;
}) => {
  const { t } = useLingui();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>
          <Heading>{title ?? t`Not found`}</Heading>
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
  icon,
}: {
  crumbs?: readonly Crumb[];
  title?: string;
  icon?: LucideIcon;
}) => {
  const { t } = useLingui();
  return (
    <Place crumbs={crumbs ?? [{ label: t`Not found` }]}>
      <NotFoundState icon={icon} title={title} />
    </Place>
  );
};

/** Asks for the page again (its loaders read from core once more), while not already `trying`. */
const TryAgain = ({ trying }: { trying: boolean }) => {
  const router = useRouter();
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
export const ErrorState = ({
  reason,
  title,
  heading: Heading = "h1",
}: {
  reason: string | undefined;
  /** What failed; "This page didn't load" without it. */
  title?: string;
  /** Its title's level: the page's own heading unless it sits in a section that has one. */
  heading?: StateHeading;
}) => {
  const { t } = useLingui();
  const trying = useRouterState({ select: (state) => state.isLoading });
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon />
        </EmptyMedia>
        <EmptyTitle>
          <Heading>{title ?? t`This page didn't load`}</Heading>
        </EmptyTitle>
        <EmptyDescription>
          {/* Gone while trying, so the alert is announced again if it fails again. */}
          {trying ? null : <ErrorText>{reason}</ErrorText>}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <TryAgain trying={trying} />
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
  title,
}: {
  crumbs?: readonly Crumb[];
  reason: string | undefined;
  title?: string;
}) => {
  const { t } = useLingui();
  return (
    <Place crumbs={crumbs ?? [{ label: title ?? t`This page didn't load` }]}>
      <ErrorState reason={reason} title={title} />
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
  icon,
}: {
  page: Exclude<Loaded<unknown>, { state: "ready" }>;
  crumbs: readonly Crumb[];
  notFound?: string;
  /** What wasn't found, as the sidebar draws it. */
  icon?: LucideIcon;
}) => {
  const { i18n, t } = useLingui();
  if (page.state === "missing") {
    return (
      <NotFound
        crumbs={[...crumbs.slice(0, -1), { label: t`Not found` }]}
        icon={icon}
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
  icon,
  heading,
}: {
  page: Exclude<Loaded<unknown>, { state: "ready" }>;
  notFound?: string;
  icon?: LucideIcon;
  heading?: StateHeading;
}) => {
  const { i18n } = useLingui();
  return page.state === "missing" ? (
    <NotFoundState heading={heading} icon={icon} title={notFound} />
  ) : (
    <ErrorState heading={heading} reason={notLoadedText(page, i18n)} />
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
 * the pages' usual layout (a heading, a line under it, then its content,
 * from the page's top left) as skeletons. Each page under the shell whose
 * address alone decides what it reads names it as its `pendingComponent`.
 * Not the shell itself, so while it asks who is in again after core was
 * out of reach, what it showed stays; and not a page that reads again as
 * its search changes (a document opened in Knowledge, a tab of Activity),
 * which keeps what it shows rather than turning back into a skeleton.
 */
export const PageLoading = () => (
  <>
    <SiteHeader crumbs={[]} />
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <LoadingLines lines={4} />
    </div>
  </>
);
