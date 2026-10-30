import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";

import { ChatDock } from "../chat/chat-dock.tsx";
import { ChatSwitcherProvider } from "../chat/chat-switcher.tsx";
import { readWithin, shellStatus } from "../core-connection.ts";
import { AppFrame } from "../frame/app-frame.tsx";
import { PageError } from "../frame/page-states.tsx";
import { landingAfterSignIn, takeJustSignedIn } from "../landing.ts";
import { RouteError } from "../route-error.tsx";
import { AppPanelProvider } from "../screens/app-panel-context.tsx";
import { AppPanelSlot } from "../screens/app-panel.tsx";
import { signInErrorSearch } from "../sign-in-errors.ts";

// The signed-in product: the app's sidebar beside the page, each page
// headed by its own site header (frame/site-header.tsx). Everyone else goes
// to the sign-in page, which sends them back here once they're in.

const Shell = () => {
  const { core, identity } = Route.useRouteContext();
  return (
    // The panel slot beside every page (screens/app-panel.tsx): outside the
    // page, so navigating the page leaves it open.
    // Keyed by who is signed in: someone else signing in on the browser
    // finds no panel of theirs open.
    <AppPanelProvider key={identity.userId}>
      {/* The chats window, ⌘K away on every page (chat/chat-switcher.tsx). */}
      <ChatSwitcherProvider>
        <AppFrame
          aside={
            <>
              <AppPanelSlot />
              <ChatDock />
            </>
          }
          core={core}
          identity={identity}
        >
          <Outlet />
        </AppFrame>
      </ChatSwitcherProvider>
    </AppPanelProvider>
  );
};

/**
 * The page to come back to after signing in: its path and search, less
 * `error`, which a refused sign-in adds and the sign-in page shows itself.
 */
const returnPathOf = (pathname: string, searchStr: string): string => {
  const search = new URLSearchParams(searchStr);
  search.delete("error");
  const rest = search.toString();
  return rest === "" ? pathname : `${pathname}?${rest}`;
};

/** Core failed or stayed out of reach while the shell asked who is in. */
class CoreUnreachableError extends Error {
  constructor() {
    // Not shown: ShellError says it in the page's language.
    super("Grasp can't be reached right now.");
    this.name = "CoreUnreachableError";
  }
}

/**
 * Says core can't be reached, with a way to ask again (not a fault, so
 * not reported), as every page shows a failure; any other error as every
 * page shows it.
 */
const ShellError = ({ error, reset, info }: ErrorComponentProps) => {
  const { t } = useLingui();
  if (!(error instanceof CoreUnreachableError)) {
    return <RouteError error={error} reset={reset} info={info} />;
  }
  return (
    <PageError
      reason={t`Grasp can't be reached right now. Try again in a moment.`}
    />
  );
};

export const Route = createFileRoute("/_shell")({
  // Before any page's loader, so each runs for someone signed in, with
  // their identity in its context.
  beforeLoad: async ({ context: { core }, location }) => {
    // Asked of core once, then known (shellStatus): no round trip before
    // each page's own reads.
    const { connected, identity } = await shellStatus(core);
    if (!connected) {
      // Nobody can tell who is signed in: sending them to sign in again
      // would say they were signed out.
      throw new CoreUnreachableError();
    }
    if (identity === undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({
        to: "/sign-in",
        search: {
          // Its search too, a deep link's input among it, but not a
          // refused sign-in's error, which is the sign-in page's own.
          returnTo: returnPathOf(location.pathname, location.searchStr),
          // A refused sign-in comes back here, as `error=<code>`.
          ...signInErrorSearch(location.search),
        },
      });
    }
    // Just back from signing in, an admin whose organization is still
    // onboarding starts in the onboarding. Core out of reach for it: home, as ever.
    const landing = takeJustSignedIn()
      ? await landingAfterSignIn({
          path: location.pathname,
          identity,
          open: async () => {
            try {
              const gate = await readWithin(
                core,
                async (session) => await session.onboardingGate.view()
              );
              return gate.open;
            } catch {
              return true;
            }
          },
        })
      : null;
    if (landing !== null) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: landing, replace: true });
    }
    return { identity };
  },
  component: Shell,
  errorComponent: ShellError,
});
