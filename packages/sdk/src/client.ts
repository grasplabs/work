// The client's public face (spec 10.7.1): the portable bootstrap a host
// outside Grasp's shell makes, `new GraspClient({ url, getToken })`, and
// mounts with `GraspProvider`; the type `useClient()` answers; and the
// structured error its calls reject with. Inside Grasp, the platform
// makes the client and mounts it around every screen (screen-runtime.ts).
// Generated App code never imports this module, and the screen compiler
// refuses it there.
//
// ```tsx
// import { GraspClient } from "@grasp-os/sdk/client";
// import { GraspProvider } from "@grasp-os/sdk/react";
//
// const client = new GraspClient({
//   url: "https://acme.grasp.example",
//   getToken: async () => await signIn.appToken(),
// });
// root.render(<GraspProvider client={client}><App /></GraspProvider>);
// ```
//
// The token is an App token of the person's (core's `POST
// /api/app-tokens/<app>`): good for one App, for minutes, and only while
// the session it came from lasts. `getToken` is asked before every call.

export { GraspClient } from "./client-core.ts";
export { GraspError } from "./client-error.ts";
export type { ErrorCategory } from "./client-error.ts";
export type { PortableClientOptions } from "./client-portable.ts";
export type {
  ActionReference,
  CallArguments,
  MutationReference,
  QueryOptions,
  QueryReference,
  SubmitOptions,
} from "./client-core.ts";
