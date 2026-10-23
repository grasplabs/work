import { linkErrors } from "@grasp-os/shared/app-links";
import { decisionErrors } from "@grasp-os/shared/decisions";
import { screenErrors } from "@grasp-os/shared/screens";
import type { ScreenTarget } from "@grasp-os/shared/screens";
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
import { i18n as pageI18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useBlocker, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { DecisionConfirmDialog } from "../decision-confirmation.tsx";
import type { PendingConfirmation } from "../decision-confirmation.tsx";
import { LinkConfirmDialog } from "../link-confirmation.tsx";
import type { PendingLink } from "../link-confirmation.tsx";
import { useCore } from "../use-core.ts";
import { frameQuestions } from "./frame-questions.ts";
import type { Asked } from "./frame-questions.ts";
import { navigationPolicy, tabBudget } from "./navigation-policy.ts";
import type { NavigationPolicy, PageState } from "./navigation-policy.ts";
import { runPreview, runScreen } from "./screen-host.ts";
import type { FailureReason, ScreenState } from "./screen-host.ts";

/**
 * What a frame's screen asks the person to confirm: a decision's answer,
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
 * (screen-links.ts).
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
  forbidden: msg`You can't open this domain's apps: your role doesn't allow it, or the domain has read data you can't read.`,
  "not-found": msg`This domain has no such app.`,
  "not-running": msg`This domain has no version to run yet.`,
  broken: msg`This app doesn't build. Ask a builder to fix it.`,
  "timed-out": msg`This app didn't start in time.`,
  left: msg`This app left its frame and was stopped.`,
  disconnected: msg`This app lost its connection to the page and was stopped.`,
  unreviewed: msg`Nobody has approved this app's code for the domain's data yet. An admin can approve it on the domain's page.`,
  revoked: msg`The approval of this app's code was taken back, and the app was stopped. An admin can approve it again on the domain's page.`,
  "principal-changed": msg`Someone else signed in on this browser, so this app was stopped. Try again to open it as the person signed in now.`,
  "bad-input": msg`This link opens the app with something it doesn't take. Open the app from its domain instead.`,
  corrupt: msg`This app's stored code no longer matches the code that was approved, so it wasn't opened. Tell an admin.`,
  "not-sealed": msg`This version of the app hasn't been sealed, so it can't be opened. A builder can publish it again.`,
  "version-revoked": msg`This version of the app was revoked and no longer runs. An admin can make another version current.`,
  unknown: msg`The app couldn't be loaded.`,
};

interface StatusProps {
  state: ScreenState;
  onReload: () => void;
}

/** What the page says about the screen, and how to load it again. */
const ScreenStatus = ({ state, onReload }: StatusProps) => {
  const { t, i18n } = useLingui();
  if (state.status === "loading" || state.status === "running") {
    return null;
  }
  let message = i18n._(failureMessages.unknown);
  if (state.status === "updated") {
    // Only a screen holding unsaved edits shows this: one with nothing
    // to lose switches at once.
    message = t`A new version of this domain is ready. It opens once your changes are saved.`;
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
 * What a frame runs: screen `screen` of App `app`, or, with `chatId`, a
 * preview of that chat's draft of `app` (its first changed screen when
 * `screen` is left out). Plain values, so the frame starts again only
 * when one of them changes, never because the page drew itself again.
 */
interface FrameSource {
  app: string;
  screen?: string;
  chatId?: string;
  /** The route the screen was navigated to by, and its input as JSON text. */
  route?: string;
  input?: string;
  /** The surface it opens in (spec 34.1), which core checks the input with. */
  surface?: string;
  /** Running beside the page (the shell's panel), outliving its navigations. */
  beside?: boolean;
}

/** How a screen navigates the page, and holds it while a form is unsaved. */
interface FrameNavigation {
  navigate: (target: ScreenTarget, replace: boolean) => Promise<void>;
  leaveGuard: (guarded: boolean) => void;
}

/** `text` read as JSON, or null when it isn't: core refuses that input. */
const jsonInput = (text: string | undefined): unknown => {
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Starts what `source` names in `frame`, a screen over the tab's
 * connection `core`; returns what stops it.
 */
const start = (
  frame: HTMLIFrameElement,
  core: CoreConnection,
  { app, screen, chatId, route, input, surface }: FrameSource,
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void,
  confirm: (review: PendingConfirmation) => Promise<boolean>,
  confirmLink: (link: PendingLink) => Promise<boolean>,
  navigation: FrameNavigation
): (() => void) =>
  chatId === undefined
    ? runScreen(
        frame,
        core,
        app,
        screen ?? "",
        onState,
        onOpened,
        confirm,
        confirmLink,
        {
          ...(route === undefined
            ? {}
            : {
                route: {
                  route,
                  input: jsonInput(input),
                  ...(surface === undefined ? {} : { surface }),
                },
              }),
          navigation,
        }
      )
    : runPreview(
        frame,
        { chatId, app, ...(screen === undefined ? {} : { screen }) },
        onState,
        onOpened
      );

/**
 * Starts what `source` names in `frame`, as `start` does, with the
 * questions its screen asks shown through `onAsk` (frame-questions.ts);
 * returns what stops it. Once the frame stops (taken down, failed,
 * signed out), its question waiting ends unconfirmed, so no decision of a
 * screen that is gone, or of someone else, stays on the page.
 */
const startAsking = (
  frame: HTMLIFrameElement,
  core: CoreConnection,
  source: FrameSource,
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void,
  onAsk: (asked: Asked<FrameQuestion> | null) => void,
  navigation: FrameNavigation
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
    navigation
  );
  return () => {
    questions.end();
    stop();
    // A start that stopped (reloaded, or its screen changed) holds no
    // edits; the next one says when its own forms do.
    navigation.leaveGuard(false);
  };
};

/**
 * The tab's one navigation without the person acting, shared by every
 * start of every frame in it (navigation-policy.ts).
 */
const thisTab = tabBudget();

/**
 * How one start of a frame navigates the page and reports its guard,
 * under that start's policy (navigation-policy.ts): a fresh start is a
 * fresh page for it.
 */
const policedNavigation = (
  router: ReturnType<typeof useRouter>,
  navigateTo: { readonly current: ScreenNavigate | undefined },
  onGuard: (guarded: boolean) => void,
  current: { current: NavigationPolicy | null },
  frame: HTMLIFrameElement,
  beside: boolean
): FrameNavigation => {
  // Read as each navigation is asked for. Where the page is: its history
  // entry, which differs for each, even at one address. Whether the person
  // just acted: in this frame, which then holds the page's focus. The
  // browser keeps a click's activation for a few seconds, whichever frame
  // asks, so a screen that mounted after it, never clicked, can't spend it
  // as its own; and a click anywhere else on the page is never a panel's.
  const page: PageState = {
    location: () => ({
      here: router.state.location.state.__TSR_key ?? router.state.location.href,
      going:
        router.latestLocation.state.__TSR_key ?? router.latestLocation.href,
    }),
    activated: () =>
      (navigator.userActivation?.isActive ?? false) &&
      document.activeElement === frame,
    now: () => Date.now(),
  };
  const policy = navigationPolicy(
    async (target, replace) => {
      const go = navigateTo.current;
      if (go === undefined) {
        throw screenErrors.create("screen.invalid");
      }
      await go(target, replace);
    },
    page,
    thisTab,
    beside ? "beside" : "page"
  );
  // The leave dialog tells this start's policy when the person stays.
  current.current = policy;
  return {
    navigate: policy.navigate,
    leaveGuard: (guarded) => {
      policy.guardChanged(guarded);
      onGuard(guarded);
    },
  };
};

interface FrameProps extends FrameSource {
  title: string;
  onState: (state: ScreenState) => void;
  onOpened: (appName: string) => void;
  /** Shows the question waiting in its dialog, or takes it away. */
  onAsk: (asked: Asked<FrameQuestion> | null) => void;
  /** How the screen navigates the page now, read when it asks. */
  navigateTo: { readonly current: ScreenNavigate | undefined };
  /** Whether the screen holds unsaved edits now. */
  onGuard: (guarded: boolean) => void;
  /** Where the current start's navigation policy is kept, for the dialog. */
  policy: { current: NavigationPolicy | null };
}

/**
 * The sandboxed frame itself. Its document is set once the page listens
 * for it (screen-host.ts); a new element is a fresh start.
 */
const Frame = ({
  app,
  screen,
  chatId,
  route,
  input,
  surface,
  beside,
  title,
  onState,
  onOpened,
  onAsk,
  navigateTo,
  onGuard,
  policy,
}: FrameProps) => {
  const core = useCore();
  const router = useRouter();
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  useEffect(
    () =>
      frame
        ? startAsking(
            frame,
            core,
            {
              app,
              ...(screen === undefined ? {} : { screen }),
              ...(chatId === undefined ? {} : { chatId }),
              ...(route === undefined ? {} : { route }),
              ...(input === undefined ? {} : { input }),
              ...(surface === undefined ? {} : { surface }),
            },
            onState,
            onOpened,
            onAsk,
            policedNavigation(
              router,
              navigateTo,
              onGuard,
              policy,
              frame,
              beside === true
            )
          )
        : undefined,
    [
      frame,
      core,
      router,
      app,
      screen,
      chatId,
      route,
      input,
      surface,
      beside,
      onState,
      onOpened,
      onAsk,
      navigateTo,
      onGuard,
      policy,
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
 * Asks whether to leave a screen whose forms hold unsaved edits, or a
 * change whose outcome isn't known yet: once per leave, in Grasp's own
 * dialog, which the screen can't draw over or answer.
 */
export const LeaveConfirmDialog = ({
  open,
  onLeave,
  onStay,
}: {
  open: boolean;
  onLeave: () => void;
  onStay: () => void;
}) => (
  <AlertDialog
    onOpenChange={(next) => {
      if (!next) {
        onStay();
      }
    }}
    open={open}
  >
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          <Trans>Leave this app?</Trans>
        </AlertDialogTitle>
        <AlertDialogDescription>
          <Trans>
            It has changes that aren&apos;t saved, or a change it hasn&apos;t
            heard back about. Leaving loses unsaved changes; anything already
            saved or running stays.
          </Trans>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Stay</Trans>
        </AlertDialogCancel>
        <AlertDialogAction onClick={onLeave}>
          <Trans>Leave</Trans>
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/**
 * Asks once, when another version of the App was made current while its
 * screen holds unsaved edits or a change it hasn't heard back about,
 * whether to save first, the screen switching once nothing is left
 * unsaved, or to switch now (spec 11.5, 10.7.7): in Grasp's own dialog,
 * which the screen can't draw over or answer.
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
          <Trans>A new version of this app is ready</Trans>
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
 * Where a screen stands on a new version of its App: none offered, the
 * person asked (`UpdateConfirmDialog`), or saving first.
 */
type Update = "none" | "asking" | "saving";

/**
 * What `source` names, running in a sandboxed frame, inside the page's
 * own chrome: `label` and the App's name, which say an App drew what's
 * below. A screen can draw anything in its frame, a fake sign-in prompt
 * too; the chrome is how a person tells the App's part from Grasp's. It
 * doesn't print: printed, the page is the screen alone, filling the
 * paper, and the screen's own print styles decide what's on it.
 */
const FramedScreen = ({
  source,
  title,
  label,
  embedded,
  onReload,
  onNavigate,
  onEnded,
  onGuardChange,
}: {
  source: FrameSource;
  title: string;
  label: string;
  embedded: boolean;
  onReload?: () => void;
  onNavigate?: ScreenNavigate;
  onEnded?: ScreenEnded;
  onGuardChange?: (guarded: boolean) => void;
}) => {
  const Title = embedded ? "h2" : "h1";
  const [state, setState] = useState<ScreenState>({ status: "loading" });
  // Told once the screen failed or its person signed out: the frame is
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
  // Whether a form of the screen holds unsaved edits or an unknown
  // outcome: leaving the screen then, however the page leaves it, is
  // confirmed once, in Grasp's own dialog (spec 10.7.7).
  const [guarded, setGuarded] = useState(false);
  // The same, and where the screen stands on a new version, as the
  // frame's callbacks read them when they come, between renders.
  const guardedNow = useRef(false);
  const [update, setUpdate] = useState<Update>("none");
  const updateNow = useRef<Update>("none");
  // A failed or signed-out screen is emptied: nothing of it is left to lose.
  const holdsEdits =
    guarded && (state.status === "running" || state.status === "updated");
  // Beside the page (the shell's panel), the page's own navigations leave
  // the screen where it is, so only closing the tab is confirmed here; its
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
    shouldBlockFn: () => holdsEdits && !beside,
    enableBeforeUnload: () => holdsEdits,
    withResolver: true,
  });
  // The latest way to navigate, read when the screen asks: the frame keeps
  // one object for its whole start, so drawing the page again restarts
  // nothing.
  const navigateTo = useRef(onNavigate);
  const policy = useRef<NavigationPolicy | null>(null);
  useEffect(() => {
    navigateTo.current = onNavigate;
  }, [onNavigate]);

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
  // Another version made current: a screen with nothing unsaved switches
  // at once; one holding edits asks once first (spec 11.5).
  const changeState = (next: ScreenState) => {
    if (next.status === "updated" && !guardedNow.current) {
      reload();
      return;
    }
    if (next.status === "updated") {
      showUpdate("asking");
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
      <ScreenStatus onReload={reload} state={state} />
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
        source="screen"
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
          policy.current?.stayed();
        }}
        open={leaving.status === "blocked"}
      />
      <Frame
        app={source.app}
        navigateTo={navigateTo}
        policy={policy}
        onAsk={setAsked}
        onGuard={changeGuard}
        key={attempt}
        onOpened={setAppName}
        onState={changeState}
        title={title}
        {...(source.screen === undefined ? {} : { screen: source.screen })}
        {...(source.chatId === undefined ? {} : { chatId: source.chatId })}
        {...(source.route === undefined ? {} : { route: source.route })}
        {...(source.input === undefined ? {} : { input: source.input })}
        {...(source.surface === undefined ? {} : { surface: source.surface })}
        {...(source.beside === true ? { beside: true } : {})}
      />
    </div>
  );
};

/**
 * Takes the page to the screen core resolved for a screen's navigation,
 * pushing an entry or replacing the current one (`replace`), and resolves
 * once it went there: refused (`screen.navigation_cancelled`) when the
 * person chose to stay on a screen with unsaved edits.
 */
export type ScreenNavigate = (
  target: ScreenTarget,
  replace: boolean
) => Promise<void>;

interface ScreenFrameProps {
  app: string;
  screen: string;
  /** The route the screen was navigated to by, and its input as JSON text. */
  route?: string;
  input?: string;
  /** The surface it opens in, checked by core with its route. */
  surface?: string;
  /** Beside the page (the shell's panel): its navigations outlive the page's. */
  beside?: boolean;
  /** How its navigation takes the page on (`ScreenNavigate`). */
  onNavigate?: ScreenNavigate;
  /**
   * Inside a page with a heading of its own (the App's page): the App's
   * name is a second-level heading, not the page's.
   */
  embedded?: boolean;
  /** Also called when the person loads the screen again. */
  onReload?: () => void;
  /** Called once the screen failed or its person signed out. */
  onEnded?: ScreenEnded;
  /** Told whether the screen holds edits leaving would lose, as that changes. */
  onGuardChange?: (guarded: boolean) => void;
}

/** How a screen ended: it failed, and why, or its person signed out. */
export type ScreenEnded = (
  ended: Extract<ScreenState, { status: "failed" | "signed-out" }>
) => void;

/** An App's screen, running in a sandboxed frame (`FramedScreen`). */
export const ScreenFrame = ({
  app,
  screen,
  route,
  input,
  surface,
  beside = false,
  embedded = false,
  onReload,
  onNavigate,
  onEnded,
  onGuardChange,
}: ScreenFrameProps) => {
  const { t } = useLingui();
  return (
    <FramedScreen
      embedded={embedded}
      label={t`Domain app`}
      source={{
        app,
        screen,
        ...(route === undefined ? {} : { route }),
        ...(input === undefined ? {} : { input }),
        ...(surface === undefined ? {} : { surface }),
        ...(beside ? { beside } : {}),
      }}
      title={t`${screen} app`}
      {...(onReload === undefined ? {} : { onReload })}
      {...(onNavigate === undefined ? {} : { onNavigate })}
      {...(onEnded === undefined ? {} : { onEnded })}
      {...(onGuardChange === undefined ? {} : { onGuardChange })}
    />
  );
};

/**
 * A screen of the chat's draft of `app` (its first changed one when none
 * is named), running in a sandboxed frame as a preview: its server code
 * changes nothing and reads no real data, and what goes wrong goes to the
 * agent.
 */
export const PreviewFrame = ({
  chatId,
  app,
  screen,
}: {
  chatId: string;
  app: string;
  screen?: string;
}) => {
  const { t } = useLingui();
  return (
    <FramedScreen
      embedded
      label={t`Preview: changes nothing, reads no real data`}
      source={{ chatId, app, ...(screen === undefined ? {} : { screen }) }}
      title={
        screen === undefined
          ? t`Preview of the draft's first app`
          : t`Preview of the ${screen} app`
      }
    />
  );
};
