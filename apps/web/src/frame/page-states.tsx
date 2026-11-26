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
import {
  colors,
  font,
  media,
  radius,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useSyncExternalStore,
} from "react";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { Backdrop } from "../chat/backdrop/backdrop.tsx";
import type { CoreConnection, CoreReach } from "../core-connection.ts";
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
  // The one fact that can change by itself, said as it changes.
  fact: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
  },
  dot: {
    width: 8,
    height: 8,
    flexShrink: 0,
    borderRadius: radius.full,
    // In forced colours a dot's fill is dropped: its edge stays.
    borderWidth: { default: 0, [media.forcedColors]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
  },
  reachable: { backgroundColor: colors.success },
  unreachable: { backgroundColor: colors.destructive },
  checking: {
    backgroundColor: colors.mutedForeground,
    // A slow breath while it checks; still for anyone who asked for less motion.
    animationName: stylex.keyframes({
      "0%": { opacity: 1 },
      "50%": { opacity: 0.35 },
      "100%": { opacity: 1 },
    }),
    animationDuration: { default: "1.6s", [media.reducedMotion]: "0s" },
    animationIterationCount: "infinite",
  },
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
 * details), with whether Grasp can be reached first (`reach`), as the
 * tab's connection finds it. It takes the page's room (in the card under
 * the page's bar, in an App's frame, or under a page's own heading), or
 * the `whole` window outside the frame.
 */
export const PageFailed = ({
  title,
  reason,
  heading = "h1",
  whole = false,
  trying = false,
  reach,
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
  /** Whether it is being read again now: the sentence goes until it is back. */
  trying?: boolean;
  /**
   * Reads again what failed. Given a Promise, Try again works until it
   * settles and says Loaded, or Not loaded when it rejects.
   */
  onRetry: () => Promise<void> | void;
  /** A quiet way on beside Try again: Go to Chat, Fix with Grasp. */
  wayOn?: ReactNode;
  /** Whether Grasp can be reached; the line is left out without it. */
  reach?: CoreReach | undefined;
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const Title = heading;
  const facts: Record<CoreReach, string> = {
    checking: t`Checking whether Grasp can be reached`,
    // The connection keeps trying by itself: no answer yet, not none ever.
    unreachable: t`No answer from Grasp yet`,
    reachable: t`Grasp can be reached`,
  };
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
      style={[styles.failed, whole && styles.failedWhole]}
      variant={{ backdrop: "dusk", pattern: "bayer", tone: "aurora" }}
    >
      <div data-slot="page-failed" {...stylex.props(styles.words)}>
        {/* Whether Grasp can be reached, first: it says at a glance whether
            the fault is this page's or Grasp's. */}
        {reach === undefined ? null : (
          <p {...stylex.props(styles.fact)}>
            <span
              aria-hidden="true"
              {...stylex.props(styles.dot, styles[reach])}
            />
            {facts[reach]}
          </p>
        )}
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
          {/* Its words for each state keep their room, so the button is as
              wide at rest as while it works (#2503's "Not loaded"). */}
          <Button
            errorText={t`Not loaded`}
            loadingText={t`Trying again`}
            onClick={onRetry}
            successText={t`Loaded`}
          >
            {t`Try again`}
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

const noWatching = () => () => {
  // Nothing to stop.
};

/**
 * Whether Grasp can be reached, as the tab's connection finds it, kept
 * current; none where the page has no connection to ask (a stand-in in a
 * test), so no line is said that isn't known.
 */
const useCoreReach = (): CoreReach | undefined => {
  // Read as what it may be: a router with no context, or a test's
  // stand-in, has none to ask.
  const context:
    | { core?: Partial<Pick<CoreConnection, "reach" | "watchReach">> }
    | undefined = useRouter().options.context;
  const core = context?.core ?? {};
  const known = typeof core.watchReach === "function";
  return useSyncExternalStore(
    (changed) => core.watchReach?.(changed) ?? noWatching(),
    () => (known ? core.reach : undefined)
  );
};

/** Loads Grasp anew, for a page whose file is gone after a new release. */
const loadAnew = () => {
  window.location.reload();
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
  reread,
}: {
  reason: string | undefined;
  /** What failed; "This page didn't load" without it. */
  title?: string;
  /** Its title's level: the page's own heading unless it sits in a section that has one. */
  heading?: StateHeading;
  /** Whether trying again loads Grasp anew: the page's file is gone after a new release. */
  reload?: boolean;
  /**
   * Starts reading again what a section reads itself, rather than the
   * page's loaders: what Try again does then, and goes back to rest.
   */
  again?: () => void;
  /**
   * Reads again what a section reads itself, done when the read is: Try
   * again waits for it and says whether it loaded. In place of `again`.
   */
  reread?: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  // Whether this failure still stands: a section read again that loaded
  // draws its data in its place, and this goes.
  const standing = useRef(true);
  useEffect(() => {
    standing.current = true;
    return () => {
      standing.current = false;
    };
  }, []);
  const sectionAgain = async (read: () => Promise<void>): Promise<void> => {
    await read();
    // Once what the read set is drawn.
    const { promise, resolve } = Promise.withResolvers<boolean>();
    requestAnimationFrame(() => {
      resolve(true);
    });
    await promise;
    if (standing.current) {
      throw new Error("It still didn't load.");
    }
  };
  const pageAgain = async (): Promise<void> => {
    await router.invalidate();
    // Read again and failed again: Try again says so.
    if (router.state.matches.some((match) => match.status === "error")) {
      throw new Error("The page still didn't load.");
    }
  };
  // What Try again does: load Grasp anew, read the section again (waited
  // on, or only started), or the page's loaders.
  const retry = (): (() => Promise<void> | void) => {
    if (reload) {
      return loadAnew;
    }
    if (reread !== undefined) {
      return async () => {
        await sectionAgain(reread);
      };
    }
    return again ?? pageAgain;
  };
  const loading = useRouterState({ select: (state) => state.isLoading });
  // Only the page's own loaders say they are on their way.
  const trying = again === undefined && reread === undefined && loading;
  const inFrame = use(InFrame);
  const reach = useCoreReach();
  return (
    <PageFailed
      heading={heading}
      reach={reach}
      whole={!inFrame}
      onRetry={retry()}
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
  again?: () => void,
  reread?: () => Promise<void>
): void => {
  const router = useRouter();
  const core = useCore();
  const offline = page.state === "offline";
  // The latest `again`, which a section may make anew at each render.
  const readAgain = useEffectEvent((): void => {
    if (reread !== undefined) {
      void reread();
      return;
    }
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
  reread,
}: {
  page: Exclude<Loaded<unknown>, { state: "ready" }>;
  notFound?: string;
  icon?: StateIcon;
  heading?: StateHeading;
  /**
   * Starts reading it again, for a section that reads it itself rather
   * than the page's loaders: on Try again, and once core is back.
   */
  again?: () => void;
  /** The same, done when the read is, so Try again says how it went (`ErrorState`). */
  reread?: () => Promise<void>;
}) => {
  const { i18n } = useLingui();
  useReadAgainWhenBack(page, again, reread);
  return page.state === "missing" ? (
    <NotFoundState heading={heading} icon={icon} title={notFound} />
  ) : (
    <ErrorState
      again={again}
      heading={heading}
      reason={notLoadedText(page, i18n)}
      reread={reread}
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
