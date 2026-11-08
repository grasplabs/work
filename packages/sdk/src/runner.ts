import { inspectApp } from "./app.ts";

export type { OperationChannel } from "./operation-channel.ts";
export { runFunction } from "./run-function.ts";
export { runMigration } from "./run-migration.ts";
export type { MigrationRow } from "./run-migration.ts";

/**
 * The manifest of `registered` (an App `app` made), as JSON text: what an
 * App's inspection isolate answers its host, which reads it as hostile
 * (`readAppManifest`). Throws for anything `app` didn't make.
 */
export const manifestOfApp = (registered: unknown): string =>
  JSON.stringify(inspectApp(registered).manifest);

// The host's module of a function's isolate puts a mutation's time and
// randomness in place with this before any App module loads.
export { installMutationRuntime } from "./mutation-runtime.ts";
export type { MutationStart } from "./mutation-runtime.ts";

// The host's entry for every App (`.grasp/app.ts`, from the compiler's
// `serverEntrySource`) registers its server functions with this, beside
// the runner the host's main modules call.
export { registerApp } from "./app.ts";
