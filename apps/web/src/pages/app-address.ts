import { useRouter, useRouterState } from "@tanstack/react-router";

// Where in an App its frame is, carried in the page's own address: the
// App's routes are its own single page app's, routed in the frame
// (@grasp-os/sdk's page-runtime.ts), and the page keeps their path in
// its address, under the App's page, so Back, Forward, reload and a
// shared link all land where the person was. The App's `/` is the App's
// page itself; every other route sits under `sub` (`/apps/<id>/pages`
// in the shell, so an App's `/settings` never meets the page's own
// `/apps/<id>/settings`).
//
// What that means for a link someone wrote: any route of an App, with any
// search parameters and hash, opens from a crafted `/apps/<id>/pages/…`
// link, for whoever the App is shared with, just as a link into any
// single page app does. Nothing about the address is trusted: what the
// App reads and writes is still checked on every call, as the person who
// opened it, and an App's routes change nothing as they load (the agent's
// rules, agent.ts); a change waits for the person's act on the page.

/** Where an App's routes sit in the page's address. */
export interface AppAddress {
  /** The App's `/`: its page. */
  readonly root: string;
  /** What every other route of the App sits under. */
  readonly sub: string;
}

/** The first `?` or `#` of `href`: where its path ends. */
const pathEnd = (href: string): number => {
  const at = href.search(/[?#]/u);
  return at === -1 ? href.length : at;
};

/**
 * The path of the App's route `href`, without its `/`: what the page's
 * own routes take as their splat (`_splat`), `""` for the App's `/`.
 */
export const appSplat = (href: string): string =>
  href.slice(0, pathEnd(href)).replace(/^\//u, "");

/** The page's address for the App's route `href` (`/tasks/12?tab=notes`). */
export const pageHref = ({ root, sub }: AppAddress, href: string): string => {
  const end = pathEnd(href);
  const path = href.slice(0, end);
  return `${path === "/" ? root : `${sub}${path}`}${href.slice(end)}`;
};

/**
 * The App's route the page's address `href` is at: `/` for the App's page,
 * the rest under `sub`, with the address's search and hash.
 */
export const appHref = ({ sub }: AppAddress, href: string): string => {
  const end = pathEnd(href);
  const path = href.slice(0, end);
  const rest = href.slice(end);
  return path.startsWith(`${sub}/`)
    ? `${path.slice(sub.length)}${rest}`
    : `/${rest}`;
};

/** Whether the page's `pathname` is one of the App's own routes. */
export const isAppPath = ({ root, sub }: AppAddress, pathname: string) =>
  pathname === root || pathname.startsWith(`${sub}/`);

/**
 * Where in the App the page's address is now (`at`), and how the frame's
 * moves go into it (`moved`): a new history entry for a push, the current
 * one otherwise, straight into the page's history, so the App's own path,
 * search and hash are kept as the App wrote them. Once the page is on its
 * way elsewhere (the App's settings, another page), `at` is nowhere and
 * the frame's moves go nowhere: the frame never calls the page back.
 */
export const useAppAddress = (
  address: AppAddress
): {
  at: string | undefined;
  handleMoved: (href: string, push: boolean) => void;
  own: (pathname: string) => boolean;
} => {
  const router = useRouter();
  const href = useRouterState({ select: ({ location }) => location.href });
  const onPage = useRouterState({
    select: ({ location }) => isAppPath(address, location.pathname),
  });
  return {
    at: onPage ? appHref(address, href) : undefined,
    handleMoved: (next, push) => {
      if (!isAppPath(address, router.state.location.pathname)) {
        return;
      }
      const target = pageHref(address, next);
      if (push) {
        router.history.push(target);
      } else {
        router.history.replace(target);
      }
    },
    own: (pathname) => isAppPath(address, pathname),
  };
};
