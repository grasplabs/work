import { authErrors } from "@grasp-os/shared/errors";
import type { Identity } from "@grasp-os/shared/rpc";

import { identify, identifyFull, signedInSession } from "./auth/identity.ts";
import type { SignedInSession } from "./auth/identity.ts";
import { reachesWorkspace } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// What a guest's session reaches (GRA-2235), named here and nowhere else.
// A guest (roles.ts `guestRole`) is someone outside the company, shared
// Apps by an admin or a builder, and an App's user in each; the platform
// otherwise answers them exactly as nobody signed in (identity.ts
// `sessionIdentity`). Default deny: what a guest may ask is listed below,
// and only what asks with a name from these lists ever reads a guest's
// identity. Everything else, a namespace or route added later included,
// keeps refusing them. Threat model on GRA-2235.
//
// Besides these, Better Auth's `GET /get-session` and `POST /sign-out`
// (auth/routes.ts) answer a guest as anyone signed in: their own session,
// and leaving it.
//
// Which Apps a guest reaches is decided where every App's access is
// (app-access.ts): only one shared with them as a person, as its user,
// and never one that holds a source, whoever shared it.

/** What a guest's connection may call over `/rpc`, as `<namespace>.<method>`. */
export const guestRpc = [
  // Who they are, which tells the page to show a guest's home.
  "whoami",
  // The live Apps shared with them, to open.
  "pages.opensApps",
  // An App's page, its frame (its live queries and the decisions its
  // runs ask on the page), and its version followed.
  "pages.open",
  "pages.frame",
  "pages.watchVersion",
  // A problem in that page, to the App's error log its builders read.
  "pages.report",
] as const;

/** One of `guestRpc`. */
export type GuestRpc = (typeof guestRpc)[number];

/** Core's own routes a guest may call, as their operations name them. */
export const guestRoutes = [
  // An App's functions, through the one page-call path (page-calls.ts).
  "app.functions",
  "app.functions.stream",
  // An App's files and links, as far as its user gets them.
  "app.files",
  "app.links",
] as const;

/** One of `guestRoutes`. */
export type GuestRoute = (typeof guestRoutes)[number];

/**
 * Who a request to `route` comes from, as `identify` says, or a guest
 * when `route` is open to guests. For the routes `guestRoutes` lists.
 */
export const identifyAppUser = async (
  env: Env,
  headers: Headers,
  route: GuestRoute
): Promise<Identity | undefined> => {
  if (!guestRoutes.includes(route)) {
    return await identify(env, headers);
  }
  const signedIn = await signedInSession(env, headers, { guests: true });
  return signedIn?.person;
};

/**
 * Who a request to `route` comes from, as `identifyFull` says (Grasp
 * staff are nobody), or a guest when `route` is open to guests.
 */
export const identifyAppUserFull = async (
  env: Env,
  headers: Headers,
  route: GuestRoute
): Promise<Identity | undefined> => {
  if (!guestRoutes.includes(route)) {
    return await identifyFull(env, headers);
  }
  const person = await identifyAppUser(env, headers, route);
  return person !== undefined && reachesWorkspace(person) ? person : undefined;
};

/**
 * The session behind a connection's cookie and who it is (rpc.ts), a
 * guest's included: what the connection then lets them call is
 * `membersOnly`'s and `openToGuests`' to decide.
 */
export const connectionSession = async (
  env: Env,
  headers: Headers
): Promise<SignedInSession | undefined> =>
  await signedInSession(env, headers, { guests: true });

/** `check` as a `SessionCheck`, its `forget` kept. */
const checked = (
  check: SessionCheck,
  run: (person: Identity) => Identity
): SessionCheck =>
  Object.assign(async (): Promise<Identity> => run(await check()), {
    forget: (): void => {
      check.forget?.();
    },
  });

/**
 * `check`, answering a guest as nobody (`auth.unauthenticated`), as every
 * route outside `guestRoutes` does: what every namespace of a connection
 * checks with, but for the methods `guestRpc` names.
 */
export const membersOnly = (check: SessionCheck): SessionCheck =>
  checked(check, (person) => {
    if (person.guest === true) {
      throw authErrors.create("auth.unauthenticated");
    }
    return person;
  });

/**
 * `check`, letting a guest through for `method`, one of `guestRpc`;
 * anyone else as `check` does.
 */
export const openToGuests = (
  check: SessionCheck,
  method: GuestRpc
): SessionCheck => (guestRpc.includes(method) ? check : membersOnly(check));
