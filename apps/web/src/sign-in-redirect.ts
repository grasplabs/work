import { redirect } from "@tanstack/react-router";
import type { ParsedLocation } from "@tanstack/react-router";

import { shellStatus } from "./core-connection.ts";
import type { CoreConnection } from "./core-connection.ts";
import { forgetSignedIn } from "./frame/signed-in-here.ts";
import { signInErrorSearch } from "./sign-in-errors.ts";

/**
 * The page to come back to after signing in: its path and search, less
 * `error` and `error_description`, which a refused sign-in adds (OAuth's
 * pair) and the sign-in page shows itself.
 */
const returnPathOf = (pathname: string, searchStr: string): string => {
  const search = new URLSearchParams(searchStr);
  search.delete("error");
  search.delete("error_description");
  const rest = search.toString();
  return rest === "" ? pathname : `${pathname}?${rest}`;
};

/**
 * The way to the sign-in page from `location`, which sends whoever signs
 * in back to it: its search too, a deep link's input among it, but not a
 * refused sign-in's error, which is the sign-in page's own and comes back
 * here as `error=<code>`.
 */
export const toSignIn = (location: ParsedLocation) =>
  redirect({
    to: "/sign-in",
    search: {
      returnTo: returnPathOf(location.pathname, location.searchStr),
      ...signInErrorSearch(location.search),
    },
  });

/**
 * Sends someone core knows isn't signed in to sign in first, then back to
 * `location`: for a page outside the shell (an App's full page or draft),
 * which can't ask them itself. While core can't be reached nobody can tell,
 * so the page opens and says so in its own way.
 */
export const signInFirst = async (
  core: CoreConnection,
  location: ParsedLocation
): Promise<void> => {
  const { connected, identity } = await shellStatus(core);
  if (connected && identity === undefined) {
    forgetSignedIn();
    // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
    throw toSignIn(location);
  }
};
