import { expectedMessageOf } from "@grasp-os/shared/errors";
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
import { Snippet } from "@grasp-os/ui/components/snippet";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { use, useEffect, useEffectEvent, useRef } from "react";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { Backdrop } from "../chat/backdrop/backdrop.tsx";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { InFrame } from "./in-frame.ts";
import { SiteHeader } from "./site-header.tsx";
import type { Crumb } from "./site-header.tsx";

/**
 * What wasn't found, as the sidebar draws it: one of Damsko's icons, or
 * one of Grasp's own drawn as a component.
 */
type StateIcon = IconData | ComponentType<SVGProps<SVGSVGElement>>;

const styles = stylex.create({
  // Under the page's bar, the state fills what is left of the card, in its
  // middle, as #2503's (frame/page-states.tsx).
  inFrame: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    flexGrow: 1,
  },
  // Not found keeps the page's room in the card, as #2503's shell gives a
  // page (28px under its bar, 24px at the sides, and at the foot the room
  // for the chat's dock over it, 96px, its `roomForDock`, as Page's
  // `pb-chat`), so it stands in the middle of that; a page that failed has
  // the whole card.
  room: {
    paddingBlockStart: space["7"],
    paddingInline: space["6"],
    paddingBlockEnd: space["24"],
  },
  // Outside the frame, it fills the window, in its middle.
  alone: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    minHeight: "100svh",
  },
  // A page that failed, as #2503's (frame/page-failed.tsx): in the card
  // under the page's bar, the page's room, the words in its middle; the
  // whole window when the shell itself could not load.
  failed: {
    display: "grid",
    boxSizing: "border-box",
    width: "100%",
    minHeight: "32rem",
    flexGrow: 1,
    paddingInline: space["6"],
    paddingBlock: space["12"],
  },
  failedWhole: { minHeight: "100dvh" },
  // Under a page's own heading (a section's): no page-sized room, only a
  // section's.
  failedSection: { minHeight: 0, paddingBlock: space["6"] },
  words: {
    display: "grid",
    justifyItems: "center",
    alignSelf: "center",
    justifySelf: "center",
    gap: space["4"],
    maxWidth: "28rem",
    textAlign: "center",
  },
  // #2503's failed page's heading: the serif at the large heading's size,
  // wrapped as it falls, at the serif's own spacing. Damsko's Heading
  // balances its lines and tightens the serif (registry gap of 25 Nov
  // 2026), so a long title broke elsewhere.
  failedTitle: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: font.headingLg,
    lineHeight: font.headingLgLine,
    fontWeight: font.weightNormal,
    color: colors.foreground,
    overflowWrap: "break-word",
  },
  sentence: {
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    color: colors.bodyForeground,
    textWrap: "pretty",
    overflowWrap: "anywhere",
  },
  reference: { width: "min(100%, 18rem)" },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space["2"],
  },
  lines: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    width: "100%",
  },
  line: { width: "100%" },
  lastLine: { width: "66%" },
  loading: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    padding: space["6"],
  },
  heading: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
  },
  title: { width: "12rem", maxWidth: "100%" },
  description: { width: "18rem", maxWidth: "100%" },
});

// How every page finds nothing, fails and loads, the same on each, on
// Damsko's parts, as #2503's frame draws them: not found as an Empty under
// the page's crumbs, saying why it isn't there; a page that failed as its
// failed page (frame/page-failed.tsx), with core's reason, its reference
// to copy and a way to try again; and skeletons while a slow read comes.
// Where one stands for the whole page in the frame, it also offers the way
// to Chat, so nobody is left on it with nowhere to go. Inside the frame
// each keeps the site header, and with it the way to the sidebar on a
// phone; outside it (core out of reach, a page such as sign-in) the state
// fills the window on its own.

/** The page's place: in the frame's <main> under its header, or a window of its own. */
const Place = ({
  crumbs,
  room = false,
  children,
}: {
  crumbs: readonly Crumb[];
  /** Whether it keeps the page's room round it in the card (`styles.room`). */
  room?: boolean;
  children: ReactNode;
}) =>
  use(InFrame) ? (
    <>
      <SiteHeader crumbs={crumbs} />
      <div {...stylex.props(styles.inFrame, room && styles.room)}>
        {children}
      </div>
    </>
  ) : (
    <main {...stylex.props(styles.alone)}>{children}</main>
  );

/**
 * The level of a state's title: `h1` where it stands for the page, lower
 * where it sits under the page's own heading (a settings section's `h3`,
 * under the page's and the section's).
 */
type StateHeading = "h1" | "h2" | "h3";

/** A heading's level, as Damsko's Empty and Heading take it. */
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

/** The way on from a page that isn't there or didn't load: Chat, the product's home. */
const GoToChat = () => (
  <Button asChild variant="outline">
    <Link to="/">
      <Trans>Go to Chat</Trans>
    </Link>
  </Button>
);

/** Whether a state's icon is one of Damsko's, rather than drawn as a component. */
const isIconData = (icon: StateIcon): icon is IconData => Array.isArray(icon);

/** What wasn't found, over its title: its icon, or the picture of no page here. */
const LostMedia = ({ icon }: { icon: StateIcon | undefined }) => {
  if (icon === undefined) {
    return <EmptyMedia illustration="lost" />;
  }
  if (isIconData(icon)) {
    return <EmptyMedia icon={icon} />;
  }
  const Drawn = icon;
  return (
    <EmptyMedia>
      <Drawn aria-hidden="true" />
    </EmptyMedia>
  );
};

/** Not found, in a page that keeps its own frame, such as the Brain with its navigation. */
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
    // The whole page when it stands for the page; a section's size inside
    // a page that keeps its own frame.
    <Empty {...(heading === "h1" ? { size: "lg" as const } : {})}>
      <EmptyHeader>
        <LostMedia icon={icon} />
        <EmptyTitle level={levels[heading]}>
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
    <Place crumbs={crumbs ?? [{ label: t`Not found` }]} room>
      <NotFoundState icon={icon} title={title} />
    </Place>
  );
};

/** How a reason carries its reference: `withReference` in @grasp-os/shared/errors. */
const referenced = /^(?<sentence>[\s\S]*?)\s*Reference: (?<reference>\S+)$/u;

/**
 * A failure's words and its reference apart, as #2503's failed page shows
 * them: the sentence to read, and the request id to copy for support,
 * where core gave one.
 */
export const splitReference = (
  reason: string
): { sentence: string; reference?: string } => {
  const found = referenced.exec(reason)?.groups;
  if (found?.sentence === undefined || found.reference === undefined) {
    return { sentence: reason };
  }
  return { sentence: found.sentence, reference: found.reference };
};

/**
 * A page that failed, as #2503's failed page draws it (frame/page-failed.tsx):
 * on its dither (dusk, Bayer's cells, the aurora's greens, faded out at
 * the foot), a real heading, the one plain sentence it was given (said as
 * it appears), the reference to copy, Try again and the quiet way on
 * (`wayOn`), and anything folded under it (`children`, a frame's technical
 * details). It takes the page's room (in the card under the page's bar,
 * or in an App's frame), the `whole` window outside the frame, or only a
 * `section`'s under a page's own heading.
 */
export const PageFailed = ({
  title,
  reason,
  heading = "h1",
  whole = false,
  section = false,
  trying = false,
  onRetry,
  wayOn,
  children,
}: {
  /** What failed, as its heading: "This page didn't load". */
  title: string;
  /** Why, in one plain sentence, with its reference if core gave one (split off to copy). */
  reason: string | undefined;
  /** Its heading's level: the page's own unless it sits under one. */
  heading?: StateHeading;
  /** Whether it is the whole window: outside the frame, where nothing else stands. */
  whole?: boolean;
  /** Whether it stands in a section under a page's own heading: a section's room, not the page's. */
  section?: boolean;
  /** Whether it is being read again now: Try again waits, and the sentence goes until it is back. */
  trying?: boolean;
  /** Reads again what failed. */
  onRetry: () => void;
  /** A quiet way on beside Try again: Go to Chat, Fix with Grasp. */
  wayOn?: ReactNode;
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const words = useRef<HTMLDivElement>(null);
  const Title = heading;
  const split: { sentence?: string; reference?: string } =
    reason === undefined ? {} : splitReference(reason);
  const { reference } = split;
  // Only words that tell the reader something, as #2503's: core's words
  // for "anything nobody planned for" say only that it failed, which the
  // title says already.
  const said = split.sentence?.trim() ?? "";
  const sentence =
    said === "" ||
    said === expectedMessageOf("internal.unexpected") ||
    said === t`Something went wrong.`
      ? undefined
      : said;
  return (
    <Backdrop
      clear={words}
      style={[
        styles.failed,
        whole && styles.failedWhole,
        section && styles.failedSection,
      ]}
      variant={{ backdrop: "dusk", pattern: "bayer", tone: "aurora" }}
    >
      <div data-slot="page-failed" ref={words} {...stylex.props(styles.words)}>
        <Title {...stylex.props(styles.failedTitle)}>{title}</Title>
        {/* Said once as it appears; gone while trying, so it is said
            again if it fails again. */}
        {trying || sentence === undefined ? null : (
          <p role="alert" {...stylex.props(styles.sentence)}>
            {sentence}
          </p>
        )}
        {reference === undefined ? null : (
          <Snippet
            aria-label={t`Reference for support`}
            size="sm"
            style={styles.reference}
            value={reference}
          />
        )}
        <div {...stylex.props(styles.actions)}>
          <Button disabled={trying} onClick={onRetry}>
            {trying ? t`Trying again…` : t`Try again`}
          </Button>
          {wayOn}
        </div>
        {children}
      </div>
      {/* Without a useful reason the title is said, from a line only a
          screen reader reads. */}
      {trying || sentence !== undefined ? null : (
        <p role="alert" {...stylex.props(visuallyHidden)}>
          {title}
        </p>
      )}
    </Backdrop>
  );
};

/**
 * The error, in a page that keeps its own frame, such as the Brain with
 * its navigation: the failed page (`PageFailed`) with core's reason. Try
 * again asks for the page again (its loaders read from core once more),
 * or for what a section reads itself (`again`), or, to `reload`, loads
 * Grasp anew; where it stands for the page in the frame, the way on is
 * Chat.
 */
export const ErrorState = ({
  reason,
  title,
  heading = "h1",
  reload = false,
  again,
}: {
  reason: string | undefined;
  /** What failed; "This page didn't load" without it. */
  title?: string;
  /** Its title's level: the page's own heading unless it sits in a section that has one. */
  heading?: StateHeading;
  /** Whether trying again loads Grasp anew: the page's file is gone after a new release. */
  reload?: boolean;
  /**
   * Reads again what a section reads itself, rather than the page's
   * loaders: what Try again does then.
   */
  again?: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const loading = useRouterState({ select: (state) => state.isLoading });
  // Only the page's own loaders say they are on their way.
  const trying = again === undefined && loading;
  const inFrame = use(InFrame);
  return (
    <PageFailed
      heading={heading}
      section={heading !== "h1"}
      whole={!inFrame}
      onRetry={() => {
        if (reload) {
          window.location.reload();
          return;
        }
        if (again === undefined) {
          void router.invalidate();
          return;
        }
        again();
      }}
      reason={reason}
      title={title ?? t`This page didn't load`}
      trying={trying}
      wayOn={offersChat(heading, inFrame) ? <GoToChat /> : undefined}
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
 * Reads again once core can be reached, while `page` says its read found
 * core out of reach: the page's loaders, or what a section reads itself
 * (`again`). At once when a connection is open already (it answered since
 * the read failed, or the read alone hung), otherwise as soon as the next
 * one answers. So "can't be reached" stays only while core can't be; a
 * read that fails again waits for the connection after. A refusal, or
 * something core doesn't have, is core's answer: never read again.
 */
const useReadAgainWhenBack = (
  page: Loaded<unknown>,
  again?: () => void
): void => {
  const router = useRouter();
  const core = useCore();
  const offline = page.state === "offline";
  // The latest `again`, which a section may make anew at each render.
  const readAgain = useEffectEvent((): void => {
    if (again === undefined) {
      void router.invalidate();
      return;
    }
    again();
  });
  useEffect(() => {
    const stop = offline
      ? core.onConnected(() => {
          readAgain();
        })
      : undefined;
    if (offline && core.connected) {
      readAgain();
    }
    return stop;
  }, [core, offline]);
};

/**
 * A page whose own read from core came back without its data: not found
 * when core has no such thing (`notFound` says what), otherwise the error.
 * `crumbs` lead to the page, ending in it. Out of reach, it reads again by
 * itself once core is back (`useReadAgainWhenBack`).
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
  useReadAgainWhenBack(page);
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

/** `PageNotLoaded` in a page that keeps its own frame, such as the Brain with its navigation. */
export const NotLoadedState = ({
  page,
  notFound,
  icon,
  heading,
  again,
}: {
  page: Exclude<Loaded<unknown>, { state: "ready" }>;
  notFound?: string;
  icon?: StateIcon;
  heading?: StateHeading;
  /**
   * Reads it again, for a section that reads it itself rather than the
   * page's loaders: on Try again, and once core is back.
   */
  again?: () => void;
}) => {
  const { i18n } = useLingui();
  useReadAgainWhenBack(page, again);
  return page.state === "missing" ? (
    <NotFoundState heading={heading} icon={icon} title={notFound} />
  ) : (
    <ErrorState
      again={again}
      heading={heading}
      reason={notLoadedText(page, i18n)}
    />
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
          size="default"
          style={line === lines - 1 ? styles.lastLine : styles.line}
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
 * its search changes (a tab of Activity),
 * which keeps what it shows rather than turning back into a skeleton.
 */
export const PageLoading = () => (
  <>
    <SiteHeader crumbs={[]} />
    <div {...stylex.props(styles.loading)}>
      <div {...stylex.props(styles.heading)}>
        <Skeleton size="lg" style={styles.title} />
        <Skeleton size="default" style={styles.description} />
      </div>
      <LoadingLines lines={4} />
    </div>
  </>
);
