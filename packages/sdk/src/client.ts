// The session client's public face (spec 10.7.1): its type, which
// `useClient()` answers, and the structured error its calls reject with.
// The platform makes the client and mounts it around every screen
// (screen-runtime.ts); generated App code never imports this module, and
// the screen compiler refuses it there.

export { GraspError } from "./client-error.ts";
export type { ErrorCategory } from "./client-error.ts";
export type {
  ActionReference,
  CallArguments,
  GraspClient,
  MutationReference,
  QueryOptions,
  QueryReference,
  SubmitOptions,
} from "./client-core.ts";
