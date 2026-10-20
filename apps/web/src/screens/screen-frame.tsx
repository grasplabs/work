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
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useBlocker, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { DecisionConfirmDialog } from "../decision-confirmation.tsx";
import type { PendingConfirmation } from "../decision-confirmation.tsx";
import { useCore } from "../use-core.ts";
import { frameQuestions } from "./frame-questions.ts";
import type { Asked } from "./frame-questions.ts";
import { navigationPolicy } from "./navigation-policy.ts";
import type { NavigationPolicy, PageState } from "./navigation-policy.ts";
import { runPreview, runScreen } from "./screen-host.ts";
import type { FailureReason, ScreenState } from "./screen-host.ts";

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
    message = t`A new version of this domain is available.`;
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
          {state.status === "updated" ? t`Reload` : t`Try again`}
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
  { app, screen, chatId, route, input }: FrameSource,
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void,
  confirm: (review: PendingConfirmation) => Promise<boolean>,
  navigation: FrameNavigation
): (() => void) =>
  chatId === undefined
    ? runScreen(frame, core, app, screen ?? "", onState, onOpened, confirm, {
        ...(route === undefined
          ? {}
          : { route: { route, input: jsonInput(input) } }),
        navigation,
      })
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
  onAsk: (asked: Asked | null) => void,
  navigation: FrameNavigation
): (() => void) => {
  const questions = frameQuestions(onAsk);
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
    questions.confirm,
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
 * How one start of a frame navigates the page and reports its guard,
 * under that start's policy (navigation-policy.ts): a fresh start is a
 * fresh page for it.
 */
const policedNavigation = (
  router: ReturnType<typeof useRouter>,
  navigateTo: { readonly current: ScreenNavigate | undefined },
  onGuard: (guarded: boolean) => void,
  current: { current: NavigationPolicy | null }
): FrameNavigation => {
  // Read as each navigation is asked for.
  const page: PageState = {
    location: () => ({
      here: router.state.location.href,
      going: router.latestLocation.href,
    }),
    activated: () => navigator.userActivation?.isActive ?? false,
    now: () => Date.now(),
  };
  const policy = navigationPolicy(async (target, replace) => {
    const go = navigateTo.current;
    if (go === undefined) {
      throw screenErrors.create("screen.invalid");
    }
    await go(target, replace);
  }, page);
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
  /** Shows the question waiting in the dialog, or takes it away. */
  onAsk: (asked: Asked | null) => void;
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
            },
            onState,
            onOpened,
            onAsk,
            policedNavigation(router, navigateTo, onGuard, policy)
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
const LeaveConfirmDialog = ({
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
}: {
  source: FrameSource;
  title: string;
  label: string;
  embedded: boolean;
  onReload?: () => void;
  onNavigate?: ScreenNavigate;
}) => {
  const Title = embedded ? "h2" : "h1";
  const [state, setState] = useState<ScreenState>({ status: "loading" });
  const [appName, setAppName] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [asked, setAsked] = useState<Asked | null>(null);
  // Whether a form of the screen holds unsaved edits or an unknown
  // outcome: leaving the screen then, however the page leaves it, is
  // confirmed once, in Grasp's own dialog (spec 10.7.7).
  const [guarded, setGuarded] = useState(false);
  // A failed or signed-out screen is emptied: nothing of it is left to lose.
  const holdsEdits =
    guarded && (state.status === "running" || state.status === "updated");
  const leaving = useBlocker({
    shouldBlockFn: () => holdsEdits,
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

  const reload = () => {
    setState({ status: "loading" });
    setAttempt(attempt + 1);
    onReload?.();
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
          if (asked?.review === review) {
            asked.settle(false);
          }
        }}
        onConfirm={(review) => {
          if (asked?.review === review) {
            asked.settle(true);
          }
        }}
        pending={asked?.review}
        source="screen"
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
        onGuard={setGuarded}
        key={attempt}
        onOpened={setAppName}
        onState={setState}
        title={title}
        {...(source.screen === undefined ? {} : { screen: source.screen })}
        {...(source.chatId === undefined ? {} : { chatId: source.chatId })}
        {...(source.route === undefined ? {} : { route: source.route })}
        {...(source.input === undefined ? {} : { input: source.input })}
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
  /** How its navigation takes the page on (`ScreenNavigate`). */
  onNavigate?: ScreenNavigate;
  /**
   * Inside a page with a heading of its own (the App's page): the App's
   * name is a second-level heading, not the page's.
   */
  embedded?: boolean;
  /** Also called when the person loads the screen again. */
  onReload?: () => void;
}

/** An App's screen, running in a sandboxed frame (`FramedScreen`). */
export const ScreenFrame = ({
  app,
  screen,
  route,
  input,
  embedded = false,
  onReload,
  onNavigate,
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
      }}
      title={t`${screen} app`}
      {...(onReload === undefined ? {} : { onReload })}
      {...(onNavigate === undefined ? {} : { onNavigate })}
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
