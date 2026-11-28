import { linkErrors } from "@grasp-os/shared/app-links";
import { decisionErrors } from "@grasp-os/shared/decisions";
import { Alert, AlertTitle } from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Heading } from "@grasp-os/ui/components/heading";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Text } from "@grasp-os/ui/components/text";
import { InfoIcon, LoaderIcon as Working } from "@grasp-os/ui/lib/icons";
import { fadeIn } from "@grasp-os/ui/lib/styles";
import { colors, radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n as pageI18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { DecisionConfirmDialog } from "../inbox/decision-confirmation.tsx";
import type { PendingConfirmation } from "../inbox/decision-confirmation.tsx";
import { LinkConfirmDialog } from "../link-confirmation.tsx";
import type { PendingLink } from "../link-confirmation.tsx";
import { useCore } from "../use-core.ts";
import { FrameCover, FrameLoading } from "./frame-cover.tsx";
import { FrameFailure } from "./frame-failure.tsx";
import { frameQuestions } from "./frame-questions.ts";
import type { Asked } from "./frame-questions.ts";
import { afterStart } from "./frame-restart.ts";
import { LeaveConfirmDialog } from "./leave-confirm-dialog.tsx";
import { frameLocation, locationHold, pageAt } from "./location-hold.ts";
import type { LocationHold } from "./location-hold.ts";
import { runPreview, runPage } from "./page-host.ts";
import type { DraftRevisions, FrameLocation, PageState } from "./page-host.ts";

/**
 * What a frame's page asks the person to confirm: a decision's answer,
 * or a link to open. One gate for both (frame-questions.ts): one dialog at
 * a time.
 */
type FrameQuestion =
  | { readonly kind: "decision"; readonly review: PendingConfirmation }
  | { readonly kind: "link"; readonly link: PendingLink };

/** Printed, the page is the page alone: the bar over it stays off the paper. */
const PRINT = "@media print";

const styles = stylex.create({
  status: { display: "flex", alignItems: "center", gap: space[2] },
  // The bar over a frame: a hairline under it, never on paper.
  bar: {
    display: { default: "flex", [PRINT]: "none" },
    alignItems: "center",
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  // What a bare frame is doing, over its corner: nothing to press, so
  // clicks go through it to the page. A width of its own, a toast's within
  // the frame: Alert's words are measured by the room they get, so a box
  // sized by its content would give them none. An opaque ground of its own,
  // a popover's, under the Alert's tint and in its corners: the page under
  // it never shows through.
  notice: {
    display: { default: "block", [PRINT]: "none" },
    position: "absolute",
    top: space[3],
    insetInlineEnd: space[3],
    width: `min(${size.toastWidth}, 100% - 2 * ${space[3]})`,
    backgroundColor: colors.popover,
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    pointerEvents: "none",
  },
  chrome: { gap: space[2], padding: space[3] },
  barEnd: { display: "flex", flexGrow: 1, justifyContent: "flex-end" },
  page: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  failure: {
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 0,
    overflowY: "auto",
    padding: space[6],
  },
  frame: { flexGrow: 1, width: "100%", borderWidth: 0 },
  hidden: { display: "none" },
});

const linkAskingPaused = msg`Another link is waiting for an answer, or one was just turned down. Try again in a moment.`;

/**
 * The refusal of a question asked while it may not be, by its kind: a
 * link's in the person's language, as the page's other link refusals are
 * (page-links.ts).
 */
const pausedFor = (question: FrameQuestion): Error => {
  if (question.kind === "decision") {
    return decisionErrors.create("decision.asking_paused");
  }
  const refusal = linkErrors.create("link.asking_paused");
  refusal.message = pageI18n._(linkAskingPaused);
  return refusal;
};

/**
 * What a frame says of a page that runs: that its preview is fixing a
 * problem, or that a new version waits for its unsaved edits; nothing
 * while it does neither.
 */
const useStatusWords = (state: PageState): string | undefined => {
  const { t } = useLingui();
  if (state.status === "fixing") {
    // Calm, and never what went wrong: the agent hears that.
    return t`Fixing a problem…`;
  }
  if (state.status === "updated") {
    // Only a page holding unsaved edits shows this: one with nothing
    // to lose switches at once.
    return t`A new version is ready: it opens once your changes are saved.`;
  }
  return undefined;
};

/** What the page's own bar says of a page that runs (`useStatusWords`). */
const RunningStatus = ({ state }: { state: PageState }) => {
  const words = useStatusWords(state);
  if (words === undefined) {
    return null;
  }
  return (
    <output {...stylex.props(styles.status)}>
      {state.status === "fixing" ? <Spinner /> : null}
      <Text as="span" size="xs" color="muted">
        {words}
      </Text>
    </output>
  );
};

/**
 * What a frame runs: the pages of App `app`, or, with `preview`, a
 * preview of the App's draft. Plain values, so the frame starts again only
 * when one of them changes, never because the page drew itself again.
 */
interface FrameSource {
  app: string;
  preview?: true;
  /** With `preview`: the draft's checkpoint to preview, read-only. */
  point?: number;
  /** With `preview`: the App's version to preview, read-only. */
  version?: number;
}

/**
 * Starts what `source` names in `frame`, a page over the tab's
 * connection `core`; returns what stops it.
 */
const start = (
  frame: HTMLIFrameElement,
  core: CoreConnection,
  { app, preview, point, version }: FrameSource,
  onState: (state: PageState) => void,
  onOpened: (appName: string) => void,
  confirm: (review: PendingConfirmation) => Promise<boolean>,
  confirmLink: (link: PendingLink) => Promise<boolean>,
  location: FrameLocation,
  leaveGuard: (guarded: boolean) => void,
  revisions: DraftRevisions
): (() => void) =>
  preview === undefined
    ? runPage(frame, core, app, onState, onOpened, confirm, confirmLink, {
        location,
        leaveGuard,
      })
    : runPreview(
        frame,
        core,
        {
          app,
          ...(point === undefined ? {} : { point }),
          ...(version === undefined ? {} : { version }),
        },
        location,
        onState,
        onOpened,
        revisions
      );

/**
 * Starts what `source` names in `frame`, as `start` does, with the
 * questions its page asks shown through `onAsk` (frame-questions.ts);
 * returns what stops it. Once the frame stops (taken down, failed,
 * signed out), its question waiting ends unconfirmed, so no decision of a
 * page that is gone, or of someone else, stays on the page.
 */
const startAsking = (
  frame: HTMLIFrameElement,
  core: CoreConnection,
  source: FrameSource,
  onState: (state: PageState) => void,
  onOpened: (appName: string) => void,
  onAsk: (asked: Asked<FrameQuestion> | null) => void,
  location: LocationHold,
  leaveGuard: (guarded: boolean) => void,
  revisions: DraftRevisions
): (() => void) => {
  const questions = frameQuestions<FrameQuestion>(onAsk, Date.now, pausedFor);
  const stop = start(
    frame,
    core,
    source,
    (state) => {
      if (state.status === "failed" || state.status === "signed-out") {
        questions.end();
      }
      onState(state);
    },
    onOpened,
    async (review) => await questions.confirm({ kind: "decision", review }),
    async (link) => await questions.confirm({ kind: "link", link }),
    frameLocation(location),
    leaveGuard,
    revisions
  );
  return () => {
    questions.end();
    stop();
    location.toFrame = undefined;
    // A start that stopped (reloaded, or its App changed) holds no
    // edits; the next one says when its own forms do.
    leaveGuard(false);
  };
};

interface FrameProps extends FrameSource {
  /**
   * With `preview`: the newest revision of the App's draft, which the
   * preview open in the frame takes as it changes, without starting
   * again (page-host.ts `runPreview`).
   */
  revision?: number;
  /** With `preview`: told its test data doesn't fit the draft's data model. */
  onTestDataStale?: () => void;
  title: string;
  onState: (state: PageState) => void;
  onOpened: (appName: string) => void;
  /** Shows the question waiting in its dialog, or takes it away. */
  onAsk: (asked: Asked<FrameQuestion> | null) => void;
  /** Where in the App the frame is (`LocationHold`). */
  location: { readonly current: LocationHold };
  /** Whether the pages hold unsaved edits now. */
  onGuard: (guarded: boolean) => void;
  /** Out of sight: its page failed, and what failed shows in its place. */
  hidden: boolean;
}

/**
 * The sandboxed frame itself. Its document is set once the page listens
 * for it (page-host.ts); a new element is a fresh start.
 */
const Frame = ({
  app,
  preview,
  point,
  version,
  revision,
  onTestDataStale,
  title,
  onState,
  onOpened,
  onAsk,
  location,
  onGuard,
  hidden,
}: FrameProps) => {
  const core = useCore();
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  // Read by the start, not a reason to start again: one object for the
  // frame's whole life, which each newer revision is passed on through.
  const revisions = useRef<DraftRevisions>({
    latest: revision,
    listener: undefined,
    onTestDataStale,
  });
  useEffect(() => {
    if (revision !== undefined) {
      revisions.current.latest = revision;
      revisions.current.listener?.(revision);
    }
  }, [revision]);
  useEffect(() => {
    revisions.current.onTestDataStale = onTestDataStale;
  }, [onTestDataStale]);
  useEffect(
    () =>
      frame
        ? startAsking(
            frame,
            core,
            {
              app,
              ...(preview === undefined ? {} : { preview }),
              ...(point === undefined ? {} : { point }),
              ...(version === undefined ? {} : { version }),
            },
            onState,
            onOpened,
            onAsk,
            location.current,
            onGuard,
            revisions.current
          )
        : undefined,
    [
      frame,
      core,
      app,
      preview,
      point,
      version,
      onState,
      onOpened,
      onAsk,
      location,
      onGuard,
    ]
  );
  return (
    <iframe
      {...stylex.props(hidden ? styles.hidden : styles.frame)}
      ref={setFrame}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      title={title}
    />
  );
};

/**
 * Asks once, when another version of the App went live while its
 * page holds unsaved edits or a change it hasn't heard back about,
 * whether to save first, the page switching once nothing is left
 * unsaved, or to switch now (spec 11.5, 10.7.7): in Grasp's own dialog,
 * which the page can't draw over or answer.
 */
const UpdateConfirmDialog = ({
  open,
  onSaveFirst,
  onSwitch,
}: {
  open: boolean;
  onSaveFirst: () => void;
  onSwitch: () => void;
}) => {
  const { t } = useLingui();
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          onSaveFirst();
        }
      }}
      open={open}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`A new version of this App is ready`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`It has changes that aren't saved, or a change it hasn't heard back about. Save them first and it switches once they are, or switch now and lose what isn't saved.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Save first`}</AlertDialogCancel>
          {/* Switching loses what isn't saved: the danger answer. */}
          <AlertDialogAction onClick={onSwitch} variant="destructive">
            {t`Switch now`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/**
 * Where a page stands on a new version of its App: none offered, the
 * person asked (`UpdateConfirmDialog`), or saving first.
 */
type Update = "none" | "asking" | "saving";

/**
 * The bar over a frame: the page's own chrome, `label` and the App's
 * name, which say an App drew what's below (`chrome`); or none, in the
 * App's workspace, whose own bar names the App already (`bare`): there
 * only what the page is doing shows, while it does, over the frame's
 * corner (`FrameNotice`).
 */
type FrameBar = { kind: "chrome"; label?: string } | { kind: "bare" };

/** Fix with Grasp for the frame `ended` at `path`, when it is offered. */
const fixOf = (
  onFix: FrameFix | undefined,
  ended: Extract<PageState, { status: "failed" | "signed-out" }>,
  path: string
): (() => void) | undefined =>
  onFix === undefined
    ? undefined
    : () => {
        onFix(ended, path);
      };

/** The bar over a frame (`FrameBar`), with what it says of its page. */
const FrameTop = ({
  bar,
  embedded,
  appName,
  state,
}: {
  bar: FrameBar;
  embedded: boolean;
  appName: string;
  state: PageState;
}) => {
  if (bar.kind === "bare") {
    return null;
  }
  return (
    <header {...stylex.props(styles.bar, styles.chrome)}>
      {bar.label === undefined ? null : <Badge>{bar.label}</Badge>}
      <Heading level={embedded ? 2 : 1} size="2xs">
        {appName}
      </Heading>
      <span {...stylex.props(styles.barEnd)}>
        <RunningStatus state={state} />
      </span>
    </header>
  );
};

/**
 * What a frame with no bar of its own (`bare`) is doing, while it does:
 * over its corner, never in a row above it, which would come and go as
 * the page works and move the page under the person's pointer while they
 * use it. It has nothing to press, so clicks go through it to the page.
 */
const FrameNotice = ({ state }: { state: PageState }) => {
  const words = useStatusWords(state);
  if (words === undefined) {
    return null;
  }
  return (
    <div {...stylex.props(styles.notice, fadeIn)}>
      <Alert
        icon={state.status === "fixing" ? Working : InfoIcon}
        live="polite"
      >
        <AlertTitle>{words}</AlertTitle>
      </Alert>
    </div>
  );
};

/** What covers a frame while it starts: a preview, or an App's page. */
const FrameStarting = ({ preview }: { preview: boolean }) => {
  const { t } = useLingui();
  return (
    <FrameLoading
      label={preview ? t`Preparing the preview` : t`Loading the app`}
    />
  );
};

/** What covers a frame in `state`: while it starts, `FrameStarting`. */
const startingCover = (state: PageState, preview: boolean): ReactNode =>
  state.status === "loading" ? <FrameStarting preview={preview} /> : null;

/**
 * What `source` names, running in a sandboxed frame, under its `bar`.
 * A page can draw anything in its frame, a fake sign-in prompt too; the
 * chrome is how a person tells the App's part from Grasp's. It doesn't
 * print: printed, the page is the page alone, filling the paper, and the
 * page's own print styles decide what's on it. Once the page failed, or
 * its person signed out, what happened shows where the page was
 * (`FrameFailure`), with Fix with Grasp (`onFix`, given the path the
 * page was at) where the preview's draft broke it.
 */
const FramedPage = ({
  source,
  revision,
  onTestDataStale,
  title,
  bar,
  embedded,
  at,
  onMoved,
  ownPath,
  onReload,
  onEnded,
  onRunning,
  onFix,
}: {
  source: FrameSource;
  /** The App's preview's: the draft's newest revision (`FrameProps`). */
  revision?: number;
  /** The App's preview's: told its test data doesn't fit (`FrameProps`). */
  onTestDataStale?: () => void;
  title: string;
  bar: FrameBar;
  embedded: boolean;
  /**
   * Where the page's address says the App is: `/` for its first route,
   * and `/` without one; undefined while the page is on its way elsewhere,
   * which the frame doesn't follow.
   */
  at?: string | undefined;
  /** Told where the App's router went, for the page to carry in its address. */
  onMoved?: (href: string, push: boolean) => void;
  /**
   * Whether the page going to `pathname` stays on this App's own page:
   * its router's moves, which unsaved edits never block.
   */
  ownPath?: (pathname: string) => boolean;
  onReload?: () => void;
  onEnded?: PageEnded;
  /** Told each time the page started and runs. */
  onRunning?: () => void;
  onFix?: FrameFix;
}) => {
  const [state, setState] = useState<PageState>({ status: "loading" });
  // Told once the page failed or its person signed out: the frame is
  // emptied then, and whatever holds it may let it go.
  const endedTo = useRef(onEnded);
  useEffect(() => {
    endedTo.current = onEnded;
  }, [onEnded]);
  const runningTo = useRef(onRunning);
  useEffect(() => {
    runningTo.current = onRunning;
  }, [onRunning]);
  useEffect(() => {
    if (state.status === "failed" || state.status === "signed-out") {
      endedTo.current?.(state);
    }
    if (state.status === "running") {
      runningTo.current?.();
    }
  }, [state]);
  const [appName, setAppName] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [asked, setAsked] = useState<Asked<FrameQuestion> | null>(null);
  const question = asked?.review;
  // Whether a form of the page holds unsaved edits or an unknown
  // outcome: leaving the page then, however the page leaves it, is
  // confirmed once, in Grasp's own dialog (spec 10.7.7).
  const [guarded, setGuarded] = useState(false);
  // The same, and where the page stands on a new version, as the
  // frame's callbacks read them when they come, between renders.
  const guardedNow = useRef(false);
  const [update, setUpdate] = useState<Update>("none");
  const updateNow = useRef<Update>("none");
  // A failed or signed-out page is emptied: nothing of it is left to lose.
  const holdsEdits =
    guarded && (state.status === "running" || state.status === "updated");
  const leaving = useBlocker({
    shouldBlockFn: ({ next }) =>
      holdsEdits && ownPath?.(next.pathname) !== true,
    enableBeforeUnload: () => holdsEdits,
    withResolver: true,
  });
  // Where in the App the frame is: kept for the frame's whole life, so
  // drawing the page again restarts nothing, and a fresh start opens
  // where the last one was.
  const location = useRef<LocationHold>(locationHold(at ?? "/"));
  // Where the App's router is, as the bar shows it.
  const [path, setPath] = useState(at ?? "/");
  useEffect(() => {
    location.current.moved = (href, push) => {
      setPath(href);
      onMoved?.(href, push);
    };
  }, [onMoved]);
  // The page's address moved on its own (Back, Forward, a link of the
  // page's): the frame's router follows, never its own move coming back
  // (location-hold.ts).
  useEffect(() => {
    if (at !== undefined) {
      pageAt(location.current, at);
      setPath(location.current.href);
    }
  }, [at]);

  const reloadTo = useRef(onReload);
  useEffect(() => {
    reloadTo.current = onReload;
  }, [onReload]);
  // The App's preview's: the draft's revision as the frame's start began
  // (`afterStart`).
  const startedAt = useRef(revision);
  // The newest revision, as `reload` reads it when it comes: never a
  // reason to start the frame again by itself.
  const revisionNow = useRef(revision);
  useEffect(() => {
    revisionNow.current = revision;
  }, [revision]);

  const showUpdate = (next: Update) => {
    updateNow.current = next;
    setUpdate(next);
  };
  // A fresh start of the frame, on the version current now. What the
  // start before reports as it stops (its guard let go) changes nothing:
  // nothing is offered any more.
  const reload = () => {
    showUpdate("none");
    startedAt.current = revisionNow.current;
    setState({ status: "loading" });
    setAttempt((last) => last + 1);
    reloadTo.current?.();
  };
  // The App's preview that failed (its first build didn't build, its
  // page wasn't there, it didn't start in time) takes no updates: only a
  // running frame follows the draft's revisions. So a newer revision
  // starts it afresh (`afterStart`), as a draft that fixes it should
  // show; one that runs takes it in place.
  useEffect(() => {
    const next = afterStart(state, revision, startedAt.current);
    startedAt.current = next.startedAt;
    if (next.afresh) {
      // As `reload`, from here: nothing was offered to a failed start.
      setState({ status: "loading" });
      setAttempt((last) => last + 1);
      reloadTo.current?.();
    }
  }, [state, revision]);
  // Another version went live: a page with nothing unsaved switches
  // at once; one holding edits asks once first (spec 11.5).
  const changeState = (next: PageState) => {
    if (next.status === "updated" && !guardedNow.current) {
      reload();
      return;
    }
    if (next.status === "updated") {
      showUpdate("asking");
    }
    // Stopped (its person lost the App, its release was revoked, or the
    // session ended): nothing is offered any more, and nothing reloads.
    if (next.status === "failed" || next.status === "signed-out") {
      showUpdate("none");
    }
    setState(next);
  };
  // Nothing left unsaved while a new version waits: it switches now.
  const changeGuard = (next: boolean) => {
    guardedNow.current = next;
    setGuarded(next);
    if (!next && updateNow.current !== "none") {
      reload();
    }
  };
  const ended =
    state.status === "failed" || state.status === "signed-out"
      ? state
      : undefined;
  return (
    <div {...stylex.props(styles.page)}>
      <FrameTop appName={appName} bar={bar} embedded={embedded} state={state} />
      <DecisionConfirmDialog
        onCancel={(review) => {
          if (question?.kind === "decision" && question.review === review) {
            asked?.settle(false);
          }
        }}
        onConfirm={(review) => {
          if (question?.kind === "decision" && question.review === review) {
            asked?.settle(true);
          }
        }}
        pending={question?.kind === "decision" ? question.review : undefined}
        source="page"
      />
      <LinkConfirmDialog
        onCancel={(review) => {
          if (question?.kind === "link" && question.link === review) {
            asked?.settle(false);
          }
        }}
        onConfirm={(review) => {
          if (question?.kind === "link" && question.link === review) {
            asked?.settle(true);
          }
        }}
        pending={question?.kind === "link" ? question.link : undefined}
      />
      <UpdateConfirmDialog
        onSaveFirst={() => {
          showUpdate("saving");
        }}
        onSwitch={reload}
        open={update === "asking" && state.status === "updated"}
      />
      <LeaveConfirmDialog
        onLeave={() => {
          leaving.proceed?.();
        }}
        onStay={() => {
          leaving.reset?.();
        }}
        open={leaving.status === "blocked"}
      />
      {/* Never the blank frame: covered from the first moment until its
          page runs, or what failed shows in its place. */}
      <FrameCover cover={startingCover(state, source.preview === true)}>
        {ended === undefined ? null : (
          <div {...stylex.props(styles.failure)}>
            <FrameFailure
              onFix={fixOf(onFix, ended, path)}
              onRetry={reload}
              preview={source.preview === true}
              state={ended}
            />
          </div>
        )}
        <Frame
          app={source.app}
          hidden={ended !== undefined}
          location={location}
          onAsk={setAsked}
          onGuard={changeGuard}
          key={attempt}
          onOpened={setAppName}
          onState={changeState}
          title={title}
          {...(source.preview === undefined ? {} : { preview: source.preview })}
          {...(source.point === undefined ? {} : { point: source.point })}
          {...(source.version === undefined ? {} : { version: source.version })}
          {...(revision === undefined ? {} : { revision })}
          {...(onTestDataStale === undefined ? {} : { onTestDataStale })}
        />
      </FrameCover>
      {bar.kind === "bare" ? <FrameNotice state={state} /> : null}
    </div>
  );
};

interface PageFrameProps {
  app: string;
  /** Where the page's address says the App is: `/` for its first route. */
  at?: string | undefined;
  /** Told where the App's router went, for the page to carry in its address. */
  onMoved?: (href: string, push: boolean) => void;
  /** Whether the page going to `pathname` stays on the App's own page. */
  ownPath?: (pathname: string) => boolean;
  /**
   * Inside a page with a heading of its own (the App's page): the App's
   * name is a second-level heading, not the page's.
   */
  embedded?: boolean;
  /**
   * No bar over it (`FrameBar`), rather than the page's own chrome: the
   * App's live page in its workspace, whose own bar names it.
   */
  bare?: boolean;
  /** Also called when the person loads the App's pages again. */
  onReload?: () => void;
  /** Called once the pages failed or their person signed out. */
  onEnded?: PageEnded;
}

/** How a frame ended: it failed, and why, or its person signed out. */
export type PageEnded = (
  ended: Extract<PageState, { status: "failed" | "signed-out" }>
) => void;

/** Asks Grasp to fix what failed in a preview, at the path it was at. */
export type FrameFix = (
  ended: Extract<PageState, { status: "failed" | "signed-out" }>,
  path: string
) => void;

/** An App's pages, running in a sandboxed frame (`FramedPage`). */
export const PageFrame = ({
  app,
  at,
  onMoved,
  ownPath,
  embedded = false,
  bare = false,
  onReload,
  onEnded,
}: PageFrameProps) => {
  const { t } = useLingui();
  return (
    <FramedPage
      bar={bare ? { kind: "bare" } : { kind: "chrome" }}
      embedded={embedded}
      source={{ app }}
      title={t`App`}
      {...(at === undefined ? {} : { at })}
      {...(onMoved === undefined ? {} : { onMoved })}
      {...(ownPath === undefined ? {} : { ownPath })}
      {...(onReload === undefined ? {} : { onReload })}
      {...(onEnded === undefined ? {} : { onEnded })}
    />
  );
};

/**
 * The pages of the draft of `app`, running in a sandboxed frame as a
 * preview: its server code changes nothing and reads no real data, and
 * what goes wrong goes to the agent. With `point`, of that checkpoint of
 * the draft, or with `version`, of that version of the App, read-only.
 * `onEnded` is told once it failed (`FrameProps`). Without either, `revision`, the draft's
 * newest, comes into the open frame as it changes: each write shows
 * without starting it again, at the route it shows. In the workspace,
 * with no bar of its own (`bare`); on the draft's full page
 * (apps.$app.draft.tsx), at `at` with the page's address following it
 * (`onMoved`, `ownPath`), under the page's own chrome.
 */
export const PreviewFrame = ({
  app,
  point,
  version,
  revision,
  at,
  onMoved,
  ownPath,
  bare = true,
  onEnded,
  onRunning,
  onReload,
  onTestDataStale,
  onFix,
}: {
  app: string;
  point?: number | undefined;
  version?: number | undefined;
  revision?: number;
  at?: string | undefined;
  onMoved?: (href: string, push: boolean) => void;
  ownPath?: (pathname: string) => boolean;
  bare?: boolean;
  onEnded?: PageEnded;
  /** Told each time the frame starts again (`FramedPage`). */
  onReload?: () => void;
  onRunning?: () => void;
  onTestDataStale?: () => void;
  onFix?: FrameFix;
}) => {
  const { t } = useLingui();
  const latest = point === undefined && version === undefined;
  return (
    <FramedPage
      bar={
        bare
          ? { kind: "bare" }
          : {
              kind: "chrome",
              label: t`Preview: changes nothing, reads no real data`,
            }
      }
      embedded
      source={{
        app,
        preview: true,
        ...(point === undefined ? {} : { point }),
        ...(version === undefined ? {} : { version }),
      }}
      title={t`Your version of the App`}
      {...(latest && revision !== undefined ? { revision } : {})}
      {...(at === undefined ? {} : { at })}
      {...(onMoved === undefined ? {} : { onMoved })}
      {...(ownPath === undefined ? {} : { ownPath })}
      {...(onEnded === undefined ? {} : { onEnded })}
      {...(onRunning === undefined ? {} : { onRunning })}
      {...(onReload === undefined ? {} : { onReload })}
      {...(onTestDataStale === undefined ? {} : { onTestDataStale })}
      {...(latest && onFix !== undefined ? { onFix } : {})}
    />
  );
};
