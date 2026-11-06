import { linkErrors } from "@grasp-os/shared/app-links";
import { decisionErrors } from "@grasp-os/shared/decisions";
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
import { Button } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { i18n as pageI18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { DecisionConfirmDialog } from "../decision-confirmation.tsx";
import type { PendingConfirmation } from "../decision-confirmation.tsx";
import { LinkConfirmDialog } from "../link-confirmation.tsx";
import type { PendingLink } from "../link-confirmation.tsx";
import { useCore } from "../use-core.ts";
import { frameQuestions } from "./frame-questions.ts";
import type { Asked } from "./frame-questions.ts";
import { LeaveConfirmDialog } from "./leave-confirm-dialog.tsx";
import { frameLocation, locationHold, pageAt } from "./location-hold.ts";
import type { LocationHold } from "./location-hold.ts";
import { runPreview, runPage } from "./page-host.ts";
import type {
  DraftRevisions,
  FailureReason,
  FrameLocation,
  PageState,
} from "./page-host.ts";

/**
 * What a frame's page asks the person to confirm: a decision's answer,
 * or a link to open. One gate for both (frame-questions.ts): one dialog at
 * a time.
 */
type FrameQuestion =
  | { readonly kind: "decision"; readonly review: PendingConfirmation }
  | { readonly kind: "link"; readonly link: PendingLink };

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

const failureMessages: Readonly<Record<FailureReason, MessageDescriptor>> = {
  forbidden: msg`You can't open this App's pages: your role doesn't allow it, or the App has read data you can't read.`,
  "not-found": msg`This App has no such page.`,
  "not-running": msg`This App has no version to run yet.`,
  broken: msg`This page doesn't build. Ask a builder to fix it.`,
  "timed-out": msg`This page didn't start in time.`,
  left: msg`This page left its frame and was stopped.`,
  disconnected: msg`This page lost its connection to Grasp and was stopped.`,
  unreviewed: msg`Grasp couldn't confirm this page's code for you. Reload to try again.`,
  revoked: msg`This version of the App was revoked, and the page was stopped. An admin can make another version current.`,
  "principal-changed": msg`Someone else signed in on this browser, so this page was stopped. Try again to open it as the person signed in now.`,
  corrupt: msg`This page's stored code no longer matches the code that was published, so it wasn't opened. Tell an admin.`,
  "not-sealed": msg`This version of the App hasn't been sealed, so it can't be opened. A builder can publish it again.`,
  "version-revoked": msg`This version of the App was revoked and no longer runs. An admin can make another version current.`,
  unsupported: msg`This browser is too old for App pages. Update it, or open this page in a current Chrome, Edge, Firefox or Safari.`,
  unknown: msg`The page couldn't be loaded.`,
};

interface StatusProps {
  state: PageState;
  onReload: () => void;
}

/** What the page says about the page, and how to load it again. */
const PageStatus = ({ state, onReload }: StatusProps) => {
  const { t, i18n } = useLingui();
  if (state.status === "loading" || state.status === "running") {
    return null;
  }
  if (state.status === "fixing") {
    // Calm, and never what went wrong: the agent hears that.
    return (
      <div className="flex items-center gap-2 border-b p-3 print:hidden">
        <Spinner />
        <output className="text-sm">{t`Fixing a problem…`}</output>
      </div>
    );
  }
  let message = i18n._(failureMessages.unknown);
  if (state.status === "updated") {
    // Only a page holding unsaved edits shows this: one with nothing
    // to lose switches at once.
    message = t`A new version of this App is ready. It opens once your changes are saved.`;
  } else if (state.status === "signed-out") {
    message = t`Your session has ended. Sign in again to go on.`;
  } else if (state.status === "failed") {
    message = i18n._(failureMessages[state.reason]);
  }
  return (
    <div className="flex items-center justify-between gap-4 border-b p-3 print:hidden">
      <output className="text-sm">{message}</output>
      {state.status === "signed-out" ? null : (
        <Button onClick={onReload} size="sm" variant="outline">
          {state.status === "updated" ? t`Switch now` : t`Try again`}
        </Button>
      )}
    </div>
  );
};

/**
 * What a frame runs: the pages of App `app`, or, with `chatId`, a
 * preview of that chat's draft of `app`. Plain values, so the frame starts
 * again only when one of them changes, never because the page drew itself
 * again.
 */
interface FrameSource {
  app: string;
  chatId?: string;
  /** With `chatId`: the version of the chat's draft to preview, read-only. */
  version?: number;
  /** Running beside the page (the shell's panel), outliving its navigations. */
  beside?: boolean;
}

/**
 * Starts what `source` names in `frame`, a page over the tab's
 * connection `core`; returns what stops it.
 */
const start = (
  frame: HTMLIFrameElement,
  core: CoreConnection,
  { app, chatId, version }: FrameSource,
  onState: (state: PageState) => void,
  onOpened: (appName: string) => void,
  confirm: (review: PendingConfirmation) => Promise<boolean>,
  confirmLink: (link: PendingLink) => Promise<boolean>,
  location: FrameLocation,
  leaveGuard: (guarded: boolean) => void,
  revisions: DraftRevisions
): (() => void) =>
  chatId === undefined
    ? runPage(frame, core, app, onState, onOpened, confirm, confirmLink, {
        location,
        leaveGuard,
      })
    : runPreview(
        frame,
        { chatId, app, ...(version === undefined ? {} : { version }) },
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
   * With `chatId`: the newest revision of the chat's draft, which the
   * preview open in the frame takes as it changes, without starting
   * again (page-host.ts `runPreview`).
   */
  revision?: number;
  /**
   * With `chatId`: told the App's version the preview shows each time it
   * shows another, or undefined while it shows the draft's own changes
   * (`PreviewRefresh.appVersion`).
   */
  onShows?: (appVersion: number | undefined) => void;
  title: string;
  onState: (state: PageState) => void;
  onOpened: (appName: string) => void;
  /** Shows the question waiting in its dialog, or takes it away. */
  onAsk: (asked: Asked<FrameQuestion> | null) => void;
  /** Where in the App the frame is (`LocationHold`). */
  location: { readonly current: LocationHold };
  /** Whether the pages hold unsaved edits now. */
  onGuard: (guarded: boolean) => void;
}

/**
 * The sandboxed frame itself. Its document is set once the page listens
 * for it (page-host.ts); a new element is a fresh start.
 */
const Frame = ({
  app,
  chatId,
  version,
  revision,
  onShows,
  title,
  onState,
  onOpened,
  onAsk,
  location,
  onGuard,
}: FrameProps) => {
  const core = useCore();
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  // Read by the start, not a reason to start again: one object for the
  // frame's whole life, which each newer revision is passed on through.
  const revisions = useRef<DraftRevisions>({
    latest: revision,
    listener: undefined,
    onShows,
  });
  useEffect(() => {
    if (revision !== undefined) {
      revisions.current.latest = revision;
      revisions.current.listener?.(revision);
    }
  }, [revision]);
  useEffect(() => {
    revisions.current.onShows = onShows;
  }, [onShows]);
  useEffect(
    () =>
      frame
        ? startAsking(
            frame,
            core,
            {
              app,
              ...(chatId === undefined ? {} : { chatId }),
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
      chatId,
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
      className="w-full flex-1 border-0"
      ref={setFrame}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      title={title}
    />
  );
};

/**
 * Asks once, when another version of the App was made current while its
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
}) => (
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
        <AlertDialogTitle>
          <Trans>A new version of this App is ready</Trans>
        </AlertDialogTitle>
        <AlertDialogDescription>
          <Trans>
            It has changes that aren&apos;t saved, or a change it hasn&apos;t
            heard back about. Save them first and it switches once they are, or
            switch now and lose what isn&apos;t saved.
          </Trans>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Save first</Trans>
        </AlertDialogCancel>
        <AlertDialogAction onClick={onSwitch}>
          <Trans>Switch now</Trans>
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/**
 * Where a page stands on a new version of its App: none offered, the
 * person asked (`UpdateConfirmDialog`), or saving first.
 */
type Update = "none" | "asking" | "saving";

/**
 * What `source` names, running in a sandboxed frame, inside the page's
 * own chrome: `label` and the App's name, which say an App drew what's
 * below. A page can draw anything in its frame, a fake sign-in prompt
 * too; the chrome is how a person tells the App's part from Grasp's. It
 * doesn't print: printed, the page is the page alone, filling the
 * paper, and the page's own print styles decide what's on it.
 */
const FramedPage = ({
  source,
  revision,
  onShows,
  title,
  label,
  embedded,
  at,
  onMoved,
  ownPath,
  onReload,
  onEnded,
  onGuardChange,
}: {
  source: FrameSource;
  /** A chat's preview's: the draft's newest revision (`FrameProps`). */
  revision?: number;
  /** A chat's preview's: told the App's version it shows (`FrameProps`). */
  onShows?: (appVersion: number | undefined) => void;
  title: string;
  label: string;
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
  onGuardChange?: (guarded: boolean) => void;
}) => {
  const Title = embedded ? "h2" : "h1";
  const [state, setState] = useState<PageState>({ status: "loading" });
  // Told once the page failed or its person signed out: the frame is
  // emptied then, and whatever holds it may let it go.
  const endedTo = useRef(onEnded);
  useEffect(() => {
    endedTo.current = onEnded;
  }, [onEnded]);
  useEffect(() => {
    if (state.status === "failed" || state.status === "signed-out") {
      endedTo.current?.(state);
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
  // Beside the page (the shell's panel), the page's own navigations leave
  // the page where it is, so only closing the tab is confirmed here; its
  // own closing is the panel's to confirm (`onGuardChange`).
  const beside = source.beside === true;
  const guardTo = useRef(onGuardChange);
  useEffect(() => {
    guardTo.current = onGuardChange;
  }, [onGuardChange]);
  useEffect(() => {
    guardTo.current?.(holdsEdits);
  }, [holdsEdits]);
  const leaving = useBlocker({
    shouldBlockFn: ({ next }) =>
      holdsEdits && !beside && ownPath?.(next.pathname) !== true,
    enableBeforeUnload: () => holdsEdits,
    withResolver: true,
  });
  // Where in the App the frame is: kept for the frame's whole life, so
  // drawing the page again restarts nothing, and a fresh start opens
  // where the last one was.
  const location = useRef<LocationHold>(locationHold(at ?? "/"));
  useEffect(() => {
    location.current.moved = onMoved;
  }, [onMoved]);
  // The page's address moved on its own (Back, Forward, a link of the
  // page's): the frame's router follows, never its own move coming back
  // (location-hold.ts).
  useEffect(() => {
    if (at !== undefined) {
      pageAt(location.current, at);
    }
  }, [at]);

  const reloadTo = useRef(onReload);
  useEffect(() => {
    reloadTo.current = onReload;
  }, [onReload]);

  const showUpdate = (next: Update) => {
    updateNow.current = next;
    setUpdate(next);
  };
  // A fresh start of the frame, on the version current now. What the
  // start before reports as it stops (its guard let go) changes nothing:
  // nothing is offered any more.
  const reload = () => {
    showUpdate("none");
    setState({ status: "loading" });
    setAttempt((last) => last + 1);
    reloadTo.current?.();
  };
  // A chat's preview that failed to start (its first build didn't build,
  // its page wasn't there, it didn't start in time) takes no updates:
  // only a running frame follows the draft's revisions. So a newer
  // revision than the one it failed at starts it afresh, as a draft that
  // fixes it should show; one that runs takes it in place.
  const failedAt = useRef<number | null>(null);
  useEffect(() => {
    if (state.status !== "failed" || revision === undefined) {
      failedAt.current = null;
      return;
    }
    if (failedAt.current === null) {
      failedAt.current = revision;
      return;
    }
    if (revision > failedAt.current) {
      // As `reload`, from here: nothing was offered to a failed start.
      setState({ status: "loading" });
      setAttempt((last) => last + 1);
      reloadTo.current?.();
    }
  }, [state, revision]);
  // Another version made current: a page with nothing unsaved switches
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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b p-3 print:hidden">
        <Badge variant="secondary">{label}</Badge>
        <Title className="text-sm font-medium">{appName}</Title>
      </header>
      <PageStatus onReload={reload} state={state} />
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
      <Frame
        app={source.app}
        location={location}
        onAsk={setAsked}
        onGuard={changeGuard}
        key={attempt}
        onOpened={setAppName}
        onState={changeState}
        title={title}
        {...(source.chatId === undefined ? {} : { chatId: source.chatId })}
        {...(source.version === undefined ? {} : { version: source.version })}
        {...(revision === undefined ? {} : { revision })}
        {...(onShows === undefined ? {} : { onShows })}
      />
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
  /** Beside the page (the shell's panel): its navigations outlive the page's. */
  beside?: boolean;
  /**
   * Inside a page with a heading of its own (the App's page): the App's
   * name is a second-level heading, not the page's.
   */
  embedded?: boolean;
  /** Also called when the person loads the App's pages again. */
  onReload?: () => void;
  /** Called once the pages failed or their person signed out. */
  onEnded?: PageEnded;
  /** Told whether the pages hold edits leaving would lose, as that changes. */
  onGuardChange?: (guarded: boolean) => void;
}

/** How a frame ended: it failed, and why, or its person signed out. */
export type PageEnded = (
  ended: Extract<PageState, { status: "failed" | "signed-out" }>
) => void;

/** An App's pages, running in a sandboxed frame (`FramedPage`). */
export const PageFrame = ({
  app,
  at,
  onMoved,
  ownPath,
  beside = false,
  embedded = false,
  onReload,
  onEnded,
  onGuardChange,
}: PageFrameProps) => {
  const { t } = useLingui();
  return (
    <FramedPage
      embedded={embedded}
      label={t`App page`}
      source={{ app, ...(beside ? { beside } : {}) }}
      title={t`App`}
      {...(at === undefined ? {} : { at })}
      {...(onMoved === undefined ? {} : { onMoved })}
      {...(ownPath === undefined ? {} : { ownPath })}
      {...(onReload === undefined ? {} : { onReload })}
      {...(onEnded === undefined ? {} : { onEnded })}
      {...(onGuardChange === undefined ? {} : { onGuardChange })}
    />
  );
};

/**
 * The pages of the chat's draft of `app`, running in a sandboxed frame
 * as a preview: its server code changes nothing and reads no real data,
 * and what goes wrong goes to the agent. With `version`, of that earlier
 * version of the draft, read-only. `onEnded` is told once it failed,
 * `onShows` which version of the App it shows (`FrameProps`). Without
 * `version`, `revision`, the draft's newest, comes into the open frame as
 * it changes: each write shows without starting it again, at the route
 * it shows.
 */
export const PreviewFrame = ({
  chatId,
  app,
  version,
  revision,
  onEnded,
  onShows,
}: {
  chatId: string;
  app: string;
  version?: number;
  revision?: number;
  onEnded?: PageEnded;
  onShows?: (appVersion: number | undefined) => void;
}) => {
  const { t } = useLingui();
  return (
    <FramedPage
      embedded
      label={
        version === undefined
          ? t`Preview: changes nothing, reads no real data`
          : t`Version ${version}: read-only preview`
      }
      source={{ chatId, app, ...(version === undefined ? {} : { version }) }}
      title={t`Preview of the draft`}
      {...(version === undefined && revision !== undefined ? { revision } : {})}
      {...(onEnded === undefined ? {} : { onEnded })}
      {...(onShows === undefined ? {} : { onShows })}
    />
  );
};
