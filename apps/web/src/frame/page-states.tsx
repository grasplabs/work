import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { use } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { Skeleton } from "../grasp/skeleton/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { InFrame } from "./in-frame.ts";
import { PageFailed, useCoreReach } from "./page-failed.tsx";
import type { FailedHeading } from "./page-failed.tsx";
import { SiteHeader } from "./site-header.tsx";
import type { Crumb } from "./site-header.tsx";

const styles = stylex.create({
  // Under the page's bar, the state fills what is left of the card.
  inFrame: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
  },
  // Outside the frame, it fills the window.
  alone: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100svh",
  },
  lines: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    width: "100%",
  },
  lastLine: { width: "66%" },
  loading: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
  },
  heading: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
  },
  title: { width: "12rem", maxWidth: "100%" },
  description: { width: "18rem", maxWidth: "100%" },
});

/** What wasn't found, drawn as its page draws it: a workflow's icon, say. */
type StateIcon = IconData;

// How every page finds nothing, fails and loads, the same on each, on
// Grasp UI's parts: not found as Grasp UI's Empty under the page's crumbs,
// saying why it isn't there; a page that failed as Grasp UI's pattern
// ("A page that failed", frame/page-failed.tsx), with core's reason, its
// reference to copy, whether Grasp can be reached, and a way to try again;
// and skeletons while a slow read comes. Where one stands for the whole
// page in the frame, it also offers the way to Chat, so nobody is left on
// it with nowhere to go. Inside the frame each keeps the site header, and
// with it the way to the sidebar on a phone; outside it (core out of
// reach, a page such as sign-in) the state fills the window on its own.

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
      <div {...stylex.props(styles.inFrame)}>{children}</div>
    </>
  ) : (
    <main {...stylex.props(styles.alone)}>{children}</main>
  );

/**
 * The level of a state's title: `h1` where it stands for the page, lower
 * where it sits under the page's own heading (a settings section's `h3`,
 * under the page's and the section's).
 */
type StateHeading = FailedHeading;

/** A heading's level, as Grasp UI's Empty takes it. */
const levels = { h1: 1, h2: 2, h3: 3 } as const satisfies Record<
  StateHeading,
  number
>;

/**
 * Whether a state offers the way to Chat: where it stands for the page in
 * the frame. Not under a page's own heading, which leaves the page around
 * it to go on from, nor outside the frame, where nobody may be signed in.
 */
const offersChat = (heading: StateHeading, inFrame: boolean): boolean =>
  heading === "h1" && inFrame;

/**
 * Waits for core to answer, as the tab's connection reaches it; at once
 * where the router has no connection to ask (a stand-in in a test).
 */
const reachCore = async (
  core: Partial<Pick<CoreConnection, "api">> | undefined
): Promise<void> => {
  if (typeof core?.api === "function") {
    await core.api();
  }
};

/** The way on from a page that isn't there or didn't load: Chat, the product's home. */
const GoToChat = () => {
  const { t } = useLingui();
  return (
    <Button render={<Link to="/" />} variant="ghost">
      {t`Go to Chat`}
    </Button>
  );
};

/** Not found, in a page that keeps its own frame, such as Knowledge with its sidebar. */
export const NotFoundState = ({
  title,
  icon,
  heading = "h1",
}: {
  title?: string;
  /** What wasn't found, as the sidebar draws it: a workflow's icon, say. */
  icon?: StateIcon;
  /** Its title's level: the page's own heading unless it sits in a section that has one. */
  heading?: StateHeading;
}) => {
  const { t } = useLingui();
  const inFrame = use(InFrame);
  return (
    <Empty>
      <EmptyHeader>
        {icon === undefined ? (
          <EmptyMedia picture="lost" />
        ) : (
          <EmptyMedia icon={icon} />
        )}
        <EmptyTitle headingLevel={levels[heading]}>
          {title ?? t`This page is not here`}
        </EmptyTitle>
        <EmptyDescription>
          {/* An address no page has, or a named thing that went away. */}
          {title === undefined ? (
            <Trans>
              The address may be wrong, or the page was moved or removed.
            </Trans>
          ) : (
            <Trans>It may have been renamed or removed.</Trans>
          )}
        </EmptyDescription>
      </EmptyHeader>
      {offersChat(heading, inFrame) ? (
        <EmptyContent>
          <GoToChat />
        </EmptyContent>
      ) : null}
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
  icon?: StateIcon;
}) => {
  const { t } = useLingui();
  return (
    <Place crumbs={crumbs ?? [{ label: t`Not found` }]}>
      <NotFoundState icon={icon} title={title} />
    </Place>
  );
};

/**
 * The error, in a page that keeps its own frame, such as Knowledge with
 * its sidebar: Grasp UI's failed page, its Try again reading the page's
 * loaders from core once more (or, to `reload`, loading Grasp anew).
 */
export const ErrorState = ({
  reason,
  title,
  heading = "h1",
  reload = false,
}: {
  reason: string | undefined;
  /** What failed; "This page didn't load" without it. */
  title?: string;
  /** Its title's level: the page's own heading unless it sits in a section that has one. */
  heading?: StateHeading;
  /** Whether trying again loads Grasp anew: the page's file is gone after a new release. */
  reload?: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  // Read as what it may be: a test's stand-in router has no connection.
  const context: { core?: Partial<Pick<CoreConnection, "api">> } | undefined =
    router.options.context;
  const inFrame = use(InFrame);
  const reach = useCoreReach();
  return (
    <PageFailed
      heading={heading}
      onRetry={async () => {
        if (reload) {
          window.location.reload();
          return;
        }
        // Core first, while the button says it is trying: the page is read
        // again only once core answers, so a page out of reach stays as it
        // is and its button says it failed, rather than being drawn anew
        // with a button that never showed it was busy. `api` cuts the
        // connection's pause before its next attempt short, and gives up
        // in a few seconds.
        await reachCore(context?.core);
        // The page's loaders read from core once more; still failing, the
        // button says so.
        await router.invalidate();
        if (router.state.matches.some(({ status }) => status === "error")) {
          throw new Error("The page did not load.");
        }
      }}
      reach={reach}
      reason={reason}
      title={title ?? t`This page didn't load`}
      wayOn={offersChat(heading, inFrame) ? <GoToChat /> : undefined}
      whole={!inFrame}
    />
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
  reload,
}: {
  crumbs?: readonly Crumb[];
  reason: string | undefined;
  title?: string;
  /** Whether trying again loads Grasp anew. */
  reload?: boolean;
}) => {
  const { t } = useLingui();
  return (
    <Place crumbs={crumbs ?? [{ label: title ?? t`This page didn't load` }]}>
      <ErrorState reason={reason} reload={reload} title={title} />
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
  icon?: StateIcon;
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
  icon?: StateIcon;
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
      {...stylex.props(styles.lines)}
    >
      {Array.from({ length: lines }, (_, line) => (
        <Skeleton
          key={line}
          text="md"
          {...(line === lines - 1 ? { layout: styles.lastLine } : {})}
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
    <div {...stylex.props(styles.loading)}>
      <div {...stylex.props(styles.heading)}>
        <Skeleton layout={styles.title} text="lg" />
        <Skeleton layout={styles.description} text="md" />
      </div>
      <LoadingLines lines={4} />
    </div>
  </>
);
