import { isAppLayout } from "@grasp-os/compiler";
import type { App } from "@grasp-os/shared/apps";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";

import { activateThroughCandidate } from "./app-candidates.ts";
import { sealRelease } from "./app-releases.ts";

// Making a version of an App current (spec 8, 16): a version of spec 8's
// layout runs only from its sealed release, so it is sealed first, on the
// App's own store, and only then made current. Threat model, and how each
// is closed:
//
// - An activation binds a store another App's data is in: no request names
//   a store. The seal binds the App's one store, keyed by the App
//   (`app_default_stores`), created the first time a version needs one
//   (data-stores.ts, `appStoreFor`).
// - Someone without the right creates a store: only the App's builders
//   activate (`appFor … "builder"`), and sealing checks it again.
// - A version runs without its release, or on a store that is gone:
//   `makeCurrent` refuses a version of spec 8's layout whose release
//   isn't sealed, is revoked, or is bound to a deleted store, whoever calls
//   it, in the statement that makes it current. A deleted store is
//   replaced by a new one for the versions sealed after it.

/**
 * Seals `version` of `app` when it is of spec 8's layout, on the App's own
 * store when it needs one (tables or preferences).
 */
const sealForActivation = async (
  env: Env,
  by: Identity,
  app: AppId,
  version: number,
  files: Readonly<Record<string, string>>,
  building: () => Promise<void>
): Promise<void> => {
  if (isAppLayout(files)) {
    await sealRelease(env, { app, version, by, building });
  }
};

/**
 * Makes `version` of `app` the one that runs, for one of its builders,
 * through a candidate (app-candidates.ts): sealed when it is of spec 8's
 * layout, then verified and made current over
 * the version current now, or over `expected` when the caller gives it.
 */
export const activateVersion = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown,
  expected?: unknown
): Promise<App> =>
  await activateThroughCandidate(env, by, app, version, {
    expected,
    seal: async (id, number, files, building) => {
      await sealForActivation(env, by, id, number, files, building);
    },
  });
