// The client's public face: the type `useClient()` answers, and the
// structured error its calls reject with. The platform makes the client
// and mounts it around every page (page-runtime.ts). Generated App code
// never imports this module, and the App compiler refuses it there.

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
