// `@grasp-os/runtime/page`: what renders an App's pages in their frame
// (page-runtime.ts), and the session client the frame makes and mounts
// around every page, with the structured error its calls reject with.
// App code never imports it, and the App compiler refuses it there: a
// page gets the platform's client from `useClient()`.
//
// The preview's runtime (preview-runtime.ts) and React Fast Refresh
// (preview-refresh.ts) are modules of the preview kit alone, never
// exported here: refresh hooks into React as it loads, which no page
// outside a preview, and no console, may have.

export { bridge, bridgeTransport } from "./page-bridge.ts";
export type {
  PageBridge,
  PreviewApplied,
  PreviewLoad,
  Theme,
} from "./page-bridge.ts";
export { reportProblem } from "./page-problems.ts";
export { routeBy, runPage } from "./page-runtime.ts";
export type { PageHooks, PageStart } from "./page-runtime.ts";
export { GraspClient } from "./client-core.ts";
export { GraspError } from "./client-error.ts";
export type { ErrorCategory } from "./client-error.ts";
export type {
  ActionReference,
  CallArguments,
  MutationReference,
  QueryOptions,
  QueryReference,
  StreamArguments,
  StreamOptions,
  StreamReference,
  SubmitOptions,
} from "./client-core.ts";
