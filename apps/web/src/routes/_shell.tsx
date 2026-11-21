import { useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Outlet,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect } from "react";

import { ChatBar } from "../chat/chat-bar.tsx";
import { useChatPanels } from "../chat/chat-panel.tsx";
import { ChatSwitcherProvider } from "../chat/chat-switcher.tsx";
import { GlobalChatProvider, useGlobalChat } from "../chat/global-chat.tsx";
import { readWithin, shellStatus } from "../core-connection.ts";
import { failingUpFront, providersOf } from "../frame/ai-key-banner.tsx";
import { AppFrame } from "../frame/app-frame.tsx";
import { useMatchLatest } from "../frame/match-latest.ts";
import { usePageDock } from "../frame/page-fill.ts";
import { PageError } from "../frame/page-states.tsx";
import { ShellPending } from "../frame/shell-pending.tsx";
import { forgetSignedIn, markSignedIn } from "../frame/signed-in-here.ts";
import {
  landingAfterSignIn,
  onboardingBehind,
  takeJustSignedIn,
} from "../landing.ts";
import { RouteError } from "../route-error.tsx";
import { signInErrorSearch } from "../sign-in-errors.ts";

// The signed-in product: the app's sidebar beside the page, each page
// headed by its own site header (frame/site-header.tsx). Everyone else goes
// to the sign-in page, which sends them back here once they're in.

/**
 * The sidebar's pages: each is a file of its own (vite.config.ts), fetched
 * once the frame stands, so the first press on one waits for no file. Only
 * their code: what a page reads it reads when opened, as each read of a
 * list is recorded in core's audit trail and a page never opened must not
 * be.
 */
const sidebarPages = [
  "/_shell/",
  "/_shell/inbox",
  "/_shell/brain",
  "/_shell/brain/",
  "/_shell/projects/",
  "/_shell/apps/",
  "/_shell/workflows/",
  "/_shell/agents/",
  "/_shell/integrations/",
] as const;

/**
 * The Brain's atlas's dots, made between frames once the frame stands:
 * made as the Brain opened, they held the page still for a second.
 */
const makeBrainCloud = async () => {
  try {
    const { brainCloudReady } = await import("../brain/dot-shapes.ts");
    await brainCloudReady();
  } catch {
    // Made as the atlas opens instead.
  }
};

/** Fetches the sidebar's pages and makes the Brain's dots once the frame stands. */
const useSidebarPagesFetched = (): void => {
  const router = useRouter();
  useEffect(() => {
    const fetchCode = async (id: (typeof sidebarPages)[number]) => {
      try {
        await router.loadRouteChunk(router.routesById[id]);
      } catch {
        // Fetched again as the page opens, which says so if it fails then.
      }
    };
    for (const id of sidebarPages) {
      void fetchCode(id);
    }
    void makeBrainCloud();
  }, [router]);
};

/**
 * The frame, with Grasp's one chat (chat/global-chat.tsx): its idle bar over
 * the page, and the chat itself, docked beside the page, floating over it,
 * or full screen.
 */
const ShellFrame = () => {
  const { core, identity } = Route.useRouteContext();
  const panels = useChatPanels();
  // The chat's idle bar stands at the card's foot only while the chat is
  // closed: open beside the page or floating, the foot has no bar, so the
  // page keeps no room or fade for one.
  const { stage } = useGlobalChat();
  const { failing } = Route.useLoaderData();
  // Chat's start has no bar: its backdrop takes the whole card.
  const chatStart = useMatchLatest()({ to: "/" }) !== false;
  // A page that takes someone through a task of its own has no chat box.
  const docked = usePageDock();
  useSidebarPagesFetched();
  return (
    <AppFrame
      bar={chatStart ? "none" : "page"}
      core={core}
      dock={<ChatBar />}
      dockShown={stage.bar && docked}
      failing={failing}
      identity={identity}
      panels={panels}
    >
      <Outlet />
    </AppFrame>
  );
};

const Shell = () => {
  const { identity } = Route.useRouteContext();
  return (
    // The chats window, ⌘K away on every page (chat/chat-switcher.tsx).
    // Keyed by who is signed in: someone else signing in on the browser
    // finds nothing of theirs open.
    <ChatSwitcherProvider key={identity.userId}>
      <GlobalChatProvider>
        <ShellFrame />
      </GlobalChatProvider>
    </ChatSwitcherProvider>
  );
};

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
      // The pattern's calm sentence: the dot under it says, live, whether
      // Grasp can be reached again.
      reason={t`Grasp could not reach its servers. Nothing you saved is lost.`}
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
      forgetSignedIn();
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
    // Grasp's staff work from the admin dashboard: nothing here is theirs.
    if (identity.staff) {
      forgetSignedIn();
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/staff", replace: true });
    }
    // A guest reaches the Apps shared with them alone (routes/guest.tsx).
    if (identity.guest === true) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/guest", replace: true });
    }
    // Just back from signing in, an admin with screens of their company's
    // onboarding left starts in the onboarding. Core out of reach for it: home, as ever.
    const landing = takeJustSignedIn()
      ? await landingAfterSignIn({
          path: location.pathname,
          identity,
          open: async () => {
            try {
              const [gate, flow, place] = await readWithin(
                core,
                async (session) =>
                  await Promise.all([
                    session.onboardingGate.view(),
                    session.onboarding.flow(),
                    session.onboarding.place(),
                  ])
              );
              return onboardingBehind({
                flow,
                done: place.done,
                open: gate.open,
              });
            } catch {
              return true;
            }
          },
        })
      : null;
    // The next reload paints the frame at once (frame/shell-pending.tsx).
    markSignedIn();
    if (landing !== null) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: landing, replace: true });
    }
    return { identity };
  },
  // Which AI providers fail, for the banner over every page (an admin's):
  // read with the page, beside its own loader, so the banner comes with
  // the page instead of pushing it down, under the person's pointer, once
  // it is up. Only as the shell is entered: moving within it, preloading
  // and `invalidate` (which runs this loader again whatever
  // `shouldReload` says) read nothing, as the banner keeps itself current,
  // reading again every minute.
  loader: async ({ cause, context: { core, identity } }) => ({
    failing:
      cause === "enter"
        ? await failingUpFront(identity, providersOf(core))
        : undefined,
  }),
  component: Shell,
  // On a reload, the frame at once while core says who is in, the page's
  // skeleton in its card; moving between pages never shows it, as the
  // shell stays read.
  pendingComponent: ShellPending,
  pendingMs: 0,
  errorComponent: ShellError,
});
