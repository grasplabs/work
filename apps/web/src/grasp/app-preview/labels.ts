/** The widths the frame can stand at. `fit` fills the room it is given. */
export type AppPreviewWidth = "phone" | "tablet" | "desktop" | "fit";

/** Where the app stands: being built, loading, running, failed, or asleep. */
export type AppPreviewState =
  | "building"
  | "loading"
  | "ready"
  | "updating"
  | "failed"
  | "stopped";

/** Every word App preview's controls and status line say. */
export interface AppPreviewLabels {
  /** The region's name, said to a screen reader. */
  region: string;
  /** The reload button's name. */
  reload: string;
  /** The open-in-a-new-tab link's name. */
  open: string;
  /** The address line's name, before the path. */
  address: string;
  /** The width choices' name, as a group. */
  widths: string;
  /** Each width choice's name. */
  phone: string;
  tablet: string;
  desktop: string;
  fit: string;
  /** What the status line says in each state. */
  building: string;
  loading: string;
  ready: string;
  /** What the quiet line says while a new version is on its way, the last one still shown. */
  updating: string;
  stopped: string;
  /** The button that shows a failure's details. */
  details: string;
  /** The menu the less-used controls fold into when the preview is narrow. */
  more: string;
  /** The full-screen button's names, to go and to come back. */
  fullscreen: string;
  leaveFullscreen: string;
  /** The copy-link button's name, what the status line says once it copied, and when it could not. */
  copy: string;
  copied: string;
  copyFailed: string;
  /** The app's own back and forward, shown with `onBack` and `onForward`. */
  back: string;
  forward: string;
  /** The guard over the frame (FrameGuard): its name, the hint at its foot, and the control that gives the page back. */
  use: string;
  useHint: string;
  done: string;
}

/** The English words, used for any a caller leaves out. */
export const englishLabels: AppPreviewLabels = {
  region: "App preview",
  reload: "Reload",
  open: "Open in a new tab",
  address: "Address",
  widths: "Width",
  phone: "Phone",
  tablet: "Tablet",
  desktop: "Desktop",
  fit: "Fit",
  building: "Building the app",
  loading: "Loading the app",
  ready: "The app is running",
  updating: "Updating the app",
  stopped: "The app is asleep",
  use: "Use the app",
  useHint: "Press to use the app",
  done: "Done",
  details: "Technical details",
  more: "More",
  fullscreen: "Full screen",
  leaveFullscreen: "Leave full screen",
  copy: "Copy link",
  copied: "Link copied",
  copyFailed: "Could not copy the link",
  back: "Back",
  forward: "Forward",
};

/** What a failure says: what failed, an optional sentence and details, and the retry's words. */
export interface AppPreviewFailure {
  /** What failed, in a few words ("The app didn't start"). */
  title: string;
  /** What to do, or what happened, in one sentence. */
  description?: string;
  /** What a developer needs: an error, a log line. Folded under `labels.details`. */
  details?: string;
  /** The retry button's words. */
  retry: string;
  /**
   * The words of the button that asks the product's agent to fix it ("Fix it"). With `onFix` it is
   * the first action, Retry beside it.
   */
  fix?: string;
}

/** What a stopped (sleeping) app says, and its wake button's words. */
export interface AppPreviewStopped {
  /** What is the case, in a few words ("The app is asleep"). */
  title: string;
  /** One sentence: why, and what waking it does. */
  description?: string;
  /** The wake button's words ("Start the app"). */
  start: string;
}

export const englishFailure: AppPreviewFailure = {
  title: "The app didn't start",
  description: "The server stopped before the app was ready.",
  retry: "Try again",
};

export const englishStopped: AppPreviewStopped = {
  title: "The app is asleep",
  description:
    "It stopped after a while unused. Starting it takes a few seconds.",
  start: "Start the app",
};
