// AppPreview: a real running frontend in a frame, with what a person needs round it: where the app
// is (its path), reload, open in a new tab, and the widths it is seen at (phone, tablet, desktop,
// fit). It also says where the app stands in one `state`: being built (App building in the frame's
// place), loading, running, failed (what failed, Retry, the focus moved there) or asleep (a Start).
// Grasp's own: Palermo has no such part.
//
//   <AppPreview src="/app/" title="Your app" path="/orders" />
//   <AppPreview src={url} title="Your app" state="building" building={{ step: "Laying out the pages" }} />
//   <AppPreview src={url} title="Your app" state="failed" failure={{ title: "…", retry: "Try again" }} onRetry={retry} />
//
// The frame is strict by default: `sandbox="allow-scripts allow-forms"`, never allow-same-origin
// unless the caller widens it, no referrer, loaded lazily. It fills the width it is given and is
// as tall as {app-preview-height} unless `layout` says otherwise. Every value is a token
// (src/tokens); a caller may set layout only (`layout`).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { AppBuilding } from "../app-building";
import type { AppBuildingProps } from "../app-building";
import type { ActionState } from "../button";
import { useAction } from "../button/use-action";
import { focus } from "../focus/focus";
import { FrameGuard } from "../frame-guard";
import { visuallyHidden } from "../hidden/hidden";
import type { LayoutStyle } from "../layout/layout";
import { englishFailure, englishLabels, englishStopped } from "./labels";
import type {
  AppPreviewFailure,
  AppPreviewLabels,
  AppPreviewState,
  AppPreviewStopped,
  AppPreviewWidth,
} from "./labels";
import {
  Actions,
  Failed,
  History,
  Loading,
  More,
  Stopped,
  Updating,
  Widths,
} from "./parts";
import { styles } from "./styles";

/** What a caller may style: its size and where it sits. Never its look. */
export type AppPreviewLayoutStyle = LayoutStyle;

/**
 * How it is drawn. `browser`, a bar above with the address, the widths, reload and open;
 * `bare`, the frame alone with its controls in a small pill at its foot; `device`, a device's
 * outline round the frame at phone and tablet widths, the controls in a plain line above. Left
 * out, it is `browser`, and `device` in a room narrower than a tablet (48rem).
 */
export type AppPreviewLook = "browser" | "bare" | "device";

/** What App building shows while the app is first built: everything but its hand-over. */
export type AppPreviewBuilding = Omit<
  AppBuildingProps,
  "children" | "done" | "onDone" | "layout"
>;

/** Every prop an AppPreview takes. */
export interface AppPreviewProps {
  /** The address of the running app, loaded in the frame. Also the open-in-a-new-tab link. */
  src: string;
  /** The frame's name, said to a screen reader ("Your app"). */
  title: string;
  /** The app's current path, shown read-only in the address line ("/orders/42"). */
  path?: string;
  /**
   * Where the app stands: `building` the first time, `loading`, `ready`, `updating` (a new version
   * on its way, the last one still shown), `failed`, or `stopped` (asleep).
   * @default "ready"
   */
  status?: AppPreviewState;
  /** @deprecated Use `status`. */
  state?: AppPreviewState;
  /**
   * How it is drawn: `browser`, `bare` or `device`. Left out, it follows its own room: `browser`,
   * and `device` where the room is narrower than a tablet (48rem). Set, it stays at every width.
   * @default "browser", "device" below 48rem of its own width
   */
  variant?: AppPreviewLook;
  /** @deprecated Use `variant`. */
  look?: AppPreviewLook;
  /** The width now, for a preview your code holds. */
  width?: AppPreviewWidth;
  /**
   * The width at first, when it holds its own.
   * @default "fit"
   */
  defaultWidth?: AppPreviewWidth;
  /** Runs when a person chooses another width. */
  onWidthChange?: (width: AppPreviewWidth) => void;
  /**
   * The frame's sandbox. Widen it only for an app you trust: `allow-same-origin` beside
   * `allow-scripts` lets the app reach out of its frame.
   * @default "allow-scripts allow-forms"
   */
  sandbox?: string;
  /** What App building shows while `state` is `building`: its step, look, cursors' names. */
  building?: AppPreviewBuilding;
  /**
   * What a failure says while `state` is `failed`: its title, sentence, details and Retry's words.
   * @default { title: "The app didn't start", description: "The server stopped before the app was ready.", retry: "Try again" }
   */
  failure?: AppPreviewFailure;
  /**
   * What an asleep app says while `state` is `stopped`, and its Start's words.
   * @default { title: "The app is asleep", description: "It stopped after a while unused…", start: "Start the app" }
   */
  stopped?: AppPreviewStopped;
  /** The controls' and status line's words. Any left out are English. */
  labels?: Partial<AppPreviewLabels>;
  /** Runs after the frame reloads: the reload button was pressed. */
  onReload?: () => void;
  /** Runs when a failure's Retry is pressed. */
  onRetry?: () => void;
  /** Runs when a failure's Fix is pressed: hand the failure to the product's agent. Shows Fix (its words `failure.fix`) as the first action. */
  onFix?: () => void;
  /** Runs when an asleep app's Start is pressed. */
  onStart?: () => void;
  /**
   * Makes the path a place to go: the address becomes a field, and Enter runs this with what was
   * typed ("/orders/42"). Leave it out while the platform cannot answer, and the path stays read
   * only.
   */
  onNavigate?: (path: string) => void;
  /** Shows a back button for the app's own history, and runs when it is pressed. */
  onBack?: () => void;
  /** Shows a forward button for the app's own history, and runs when it is pressed. */
  onForward?: () => void;
  /** Whether there is somewhere to go back to. @default true */
  canGoBack?: boolean;
  /** Whether there is somewhere to go forward to. @default false */
  canGoForward?: boolean;
  /** Its size and where it sits. */
  layout?: AppPreviewLayoutStyle;
}

const statusOf = (
  state: AppPreviewState,
  labels: AppPreviewLabels,
  copied: ActionState
) => {
  if (copied === "done") {
    return labels.copied;
  }
  if (copied === "failed") {
    return labels.copyFailed;
  }
  // A failure says itself, as an alert: the status line stays quiet then.
  if (state === "failed") {
    return "";
  }
  return labels[state];
};

/** Full screen for the whole preview, its button saying which way it goes. */
const useFullscreen = (root: RefObject<HTMLElement | null>) => {
  const [full, setFull] = useState(false);
  useEffect(() => {
    const change = () => {
      setFull(
        document.fullscreenElement !== null &&
          document.fullscreenElement === root.current
      );
    };
    document.addEventListener("fullscreenchange", change);
    return () => {
      document.removeEventListener("fullscreenchange", change);
    };
  }, [root]);
  const toggle = () => {
    if (document.fullscreenElement === null) {
      void root.current?.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  };
  return [full, toggle] as const;
};

/**
 * Copies the app's address: the button's tick and the status line say so for duration-hold, or
 * that it could not, through useAction, as every copy in the library does (Copy field, Code block).
 */
const useCopy = (src: string, labels: AppPreviewLabels) => {
  const copy = useAction(
    async () => {
      await navigator.clipboard.writeText(
        new URL(src, window.location.href).href
      );
    },
    { done: labels.copied, failed: labels.copyFailed }
  );
  return [
    copy.state,
    () => {
      void copy.run();
    },
  ] as const;
};

/** The width it shows: the caller's, or its own. */
const useWidth = (
  width: AppPreviewWidth | undefined,
  defaultWidth: AppPreviewWidth,
  onWidthChange: ((width: AppPreviewWidth) => void) | undefined
) => {
  const [own, setOwn] = useState(defaultWidth);
  const shown = width ?? own;
  const choose = (next: AppPreviewWidth) => {
    setOwn(next);
    onWidthChange?.(next);
  };
  return [shown, choose] as const;
};

/** Whether the state changed after the preview first stood: a failure that arrives takes the focus. */
const useChanged = (state: AppPreviewState) => {
  const [last, setLast] = useState(state);
  const [changed, setChanged] = useState(false);
  if (last !== state) {
    setLast(state);
    setChanged(true);
  }
  return changed;
};

interface ScreenProps {
  state: AppPreviewState;
  src: string;
  title: string;
  sandbox: string;
  attempt: number;
  frameRef: (frame: HTMLIFrameElement | null) => void;
  building: AppPreviewBuilding | undefined;
  failure: AppPreviewFailure;
  stopped: AppPreviewStopped;
  labels: AppPreviewLabels;
  onRetry: (() => void) | undefined;
  onFix: (() => void) | undefined;
  onStart: (() => void) | undefined;
  arrived: boolean;
  frame: HTMLIFrameElement | null;
  onLive: (live: boolean) => void;
  /** Reload was pressed and the new frame has not loaded yet: the frame waits, as while loading. */
  reloading: boolean;
  onLoaded: () => void;
}

/** What stands in the frame: the app, App building, or a layer saying why there is no app. */
const Screen = ({
  state,
  src,
  title,
  sandbox,
  attempt,
  frameRef,
  building,
  failure,
  stopped,
  labels,
  onRetry,
  onFix,
  onStart,
  arrived,
  frame,
  onLive,
  reloading,
  onLoaded,
}: ScreenProps) => {
  if (state === "building") {
    return <AppBuilding aria-label={labels.building} {...building} />;
  }
  if (state === "failed") {
    return (
      <Failed
        failure={failure}
        labels={labels}
        onRetry={onRetry}
        onFix={onFix}
        arrived={arrived}
      />
    );
  }
  if (state === "stopped") {
    return <Stopped stopped={stopped} onStart={onStart} />;
  }
  const waiting = state === "loading" || reloading;
  return (
    <>
      <iframe
        key={attempt}
        ref={frameRef}
        src={src}
        title={title}
        sandbox={sandbox}
        referrerPolicy="no-referrer"
        loading="lazy"
        onLoad={onLoaded}
        inert={waiting}
        aria-hidden={waiting ? true : undefined}
        data-slot="app-preview-frame"
        {...stylex.props(styles.iframe, waiting && styles.iframeWaiting)}
      />
      {state === "updating" ? <Updating label={labels.updating} /> : null}
      {waiting ? (
        <Loading label={labels.loading} />
      ) : (
        <FrameGuard
          frame={frame}
          label={labels.use}
          hint={labels.useHint}
          done={labels.done}
          onLiveChange={onLive}
        />
      )}
    </>
  );
};

/** The frame's box: its width, and the device's outline or a narrow frame's hairline. */
const viewportStyles = (
  look: AppPreviewLook | undefined,
  shown: AppPreviewWidth
) => {
  const narrow = shown === "phone" || shown === "tablet";
  const fit = shown === "phone" ? styles.fitPhone : styles.fitTablet;
  if (look === undefined) {
    return [
      styles.frame,
      styles[shown],
      narrow ? [styles.autoNarrow, fit] : styles.autoWide,
    ];
  }
  if (look === "device") {
    return [
      styles.frame,
      styles[shown],
      styles.device,
      narrow ? [styles.deviceScaled, fit] : styles.deviceWide,
    ];
  }
  return [styles.frame, styles[shown], narrow && styles.narrow];
};

/** Each part's look: the browser's, the device's, or (no `look`) either by the room's width. */
const lookOf = <Device, Auto>(
  look: AppPreviewLook | undefined,
  device: Device,
  auto: Auto
): Device | Auto | false => {
  if (look === undefined) {
    return auto;
  }
  return look === "device" && device;
};

interface TopProps {
  look: AppPreviewLook | undefined;
  path: string;
  labels: AppPreviewLabels;
  children: ReactNode;
  history: ReactNode;
  onNavigate: ((path: string) => void) | undefined;
}

/** The address: the path read-only, or with `onNavigate` a field that goes there on Enter. */
const Address = ({
  path,
  labels,
  look,
  onNavigate,
}: {
  path: string;
  labels: AppPreviewLabels;
  look: AppPreviewLook | undefined;
  onNavigate: ((path: string) => void) | undefined;
}) => {
  const own = lookOf(look, styles.addressDevice, styles.addressAuto);
  if (onNavigate === undefined) {
    return (
      <p {...stylex.props(styles.address, own)} data-slot="app-preview-address">
        <span {...stylex.props(visuallyHidden)}>{labels.address}</span>
        <span {...stylex.props(styles.path)}>{path}</span>
      </p>
    );
  }
  return (
    <form
      {...stylex.props(styles.address, own, focus.within)}
      data-slot="app-preview-address"
      onSubmit={(event) => {
        event.preventDefault();
        const field = event.currentTarget.elements.namedItem("path");
        if (field instanceof HTMLInputElement) {
          onNavigate(field.value);
        }
      }}
    >
      <input
        key={path}
        name="path"
        type="text"
        defaultValue={path}
        aria-label={labels.address}
        spellCheck={false}
        {...stylex.props(styles.path, styles.pathField)}
      />
    </form>
  );
};

/** Above the frame, the bar with the address; in the bare look, the pill at its foot. */
const Top = ({
  look,
  path,
  labels,
  children,
  history,
  onNavigate,
}: TopProps) => {
  if (look === "bare") {
    return (
      <div {...stylex.props(styles.pill)} data-slot="app-preview-controls">
        {children}
      </div>
    );
  }
  return (
    <div
      {...stylex.props(
        styles.bar,
        lookOf(look, styles.barDevice, styles.barAuto)
      )}
      data-slot="app-preview-bar"
    >
      {history}
      <Address
        path={path}
        labels={labels}
        look={look}
        onNavigate={onNavigate}
      />
      {children}
    </div>
  );
};

// The default look is `browser`: a person reads a bar with an address as "a running website" at
// once, and it has room for every control without covering the app. In a room narrower than a
// tablet the room is itself a phone's or a tablet's, and the device's outline says so: that switch
// is a container query, so it is right from the first paint. `bare` suits a preview inside another
// frame (a panel, the viewer); `device` a showcase.
/** Whether the app runs in its frame: ready, or loading or updating over the last version. */
const runningOf = (state: AppPreviewState) =>
  state === "ready" || state === "loading" || state === "updating";

export const AppPreview = ({
  src,
  title,
  path = "/",
  state: stateDeprecated,
  status: state = stateDeprecated ?? "ready",
  look: lookDeprecated,
  variant: look = lookDeprecated,
  width,
  defaultWidth = "fit",
  onWidthChange,
  sandbox = "allow-scripts allow-forms",
  building,
  failure = englishFailure,
  stopped = englishStopped,
  labels,
  onReload,
  onRetry,
  onFix,
  onStart,
  onNavigate,
  onBack,
  onForward,
  canGoBack = true,
  canGoForward = false,
  layout,
}: AppPreviewProps) => {
  const root = useRef<HTMLElement>(null);
  const [full, toggleFull] = useFullscreen(root);
  const words = { ...englishLabels, ...labels };
  const [copied, copy] = useCopy(src, words);
  const history = (
    <History
      labels={words}
      onBack={onBack}
      onForward={onForward}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
    />
  );
  const [shown, choose] = useWidth(width, defaultWidth, onWidthChange);
  const [attempt, setAttempt] = useState(0);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  // Live: the frame has been asked for (FrameGuard) and takes the wheel; its box shows the ring.
  const [inside, setInside] = useState(false);
  const arrived = useChanged(state);
  // Reload answers on the frame itself: from the press until the new frame has loaded it waits,
  // as while loading, so a reload of an app that comes back the same is still seen to happen.
  const [reloading, setReloading] = useState(false);
  const reload = () => {
    setAttempt((count) => count + 1);
    setReloading(true);
    onReload?.();
  };
  const running = runningOf(state);
  const busy =
    state === "building" ||
    state === "loading" ||
    state === "updating" ||
    reloading;
  // The widths and the actions stay together; in a narrow room the widths, copy, full screen and
  // open fold into More, so the bar keeps one line and the address its room.
  const controls = (
    <span {...stylex.props(styles.controls)}>
      <span {...stylex.props(styles.folds)}>
        <Widths labels={words} width={shown} onWidth={choose} />
      </span>
      <Actions
        labels={words}
        onReload={reload}
        src={src}
        canReload={running}
        full={full}
        onFullscreen={toggleFull}
        onCopy={copy}
        copied={copied}
      />
      <More
        labels={words}
        width={shown}
        onWidth={choose}
        src={src}
        full={full}
        onFullscreen={toggleFull}
        onCopy={copy}
      />
    </span>
  );
  return (
    <section
      ref={root}
      aria-label={words.region}
      aria-busy={busy}
      data-slot="app-preview"
      data-look={look ?? "auto"}
      data-state={state}
      data-width={shown}
      {...stylex.props(styles.root, layout)}
    >
      <div
        {...stylex.props(
          styles.shell,
          lookOf(look, styles.shellDevice, styles.shellAuto)
        )}
      >
        <Top
          look={look}
          path={path}
          labels={words}
          history={history}
          onNavigate={onNavigate}
        >
          {controls}
        </Top>
        <div
          {...stylex.props(
            styles.stage,
            lookOf(look, styles.stageDevice, styles.stageAuto)
          )}
        >
          <div
            data-slot="app-preview-viewport"
            {...stylex.props(
              ...viewportStyles(look, shown),
              inside && focus.frame
            )}
          >
            <div
              {...stylex.props(
                styles.screen,
                lookOf(look, styles.screenDevice, styles.screenAuto)
              )}
            >
              <Screen
                state={state}
                src={src}
                title={title}
                sandbox={sandbox}
                attempt={attempt}
                frameRef={setFrame}
                building={building}
                failure={failure}
                stopped={stopped}
                labels={words}
                onRetry={onRetry}
                onFix={onFix}
                onStart={onStart}
                arrived={arrived}
                frame={frame}
                onLive={setInside}
                reloading={reloading && running}
                onLoaded={() => {
                  setReloading(false);
                }}
              />
            </div>
          </div>
        </div>
        <output
          {...stylex.props(visuallyHidden)}
          data-slot="app-preview-status"
        >
          {statusOf(reloading && running ? "loading" : state, words, copied)}
        </output>
      </div>
    </section>
  );
};
