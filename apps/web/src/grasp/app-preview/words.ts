// App preview's own words, in English. The product gives them in its languages through GraspWords
// (src/words), as the catalogue's `appPreview`, `appPreviewFailure` and `appPreviewStopped`; a
// caller's `labels`, `failure` and `stopped` still win until the breaking release's step 5.
import type {
  AppPreviewFailure,
  AppPreviewLabels,
  AppPreviewStopped,
} from "./labels";

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

declare module "../words/words" {
  interface GraspWordsCatalog {
    appPreview: AppPreviewLabels;
    appPreviewFailure: AppPreviewFailure;
    appPreviewStopped: AppPreviewStopped;
  }
}
