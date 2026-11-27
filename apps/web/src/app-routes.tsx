import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { CoreConnection } from "./core-connection.ts";
import { reportUncaughtErrors } from "./error-reports.ts";
import { NotFound } from "./frame/page-states.tsx";
import { UiWords } from "./frame/ui-words.tsx";
import { RouteError } from "./route-error.tsx";
import { routeTree } from "./routeTree.gen.ts";

// The whole app: every route, loaded by main.tsx at every address but the
// interview's (boot-path.ts).

// The tab's one connection to core, made once and handed to every route
// and every App frame. When the person's session ends, the frames stop and
// the page loads again: the shell finds
// nobody signed in, and sends them to sign in and back to where they were.
const core = new CoreConnection({
  onSessionEnded: () => {
    window.location.reload();
  },
});

// Every route shows a failure the same way, and reports a fault of the
// page's own to core (route-error.tsx), the root route included: the
// boundary around the whole app. What isn't there shows the same
// not-found, and each page under the shell its skeleton while it loads
// (frame/page-states.tsx).
const router = createRouter({
  routeTree,
  context: { core },
  // The page's card scrolls on its own (frame/app-frame.tsx), so a new
  // page starts at the top of it, not only of the window.
  scrollToTopSelectors: ['[data-slot="app-shell-page"]'],
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: () => <NotFound />,
});

// What the page throws and never catches, reported with the route's
// pattern (such as `/apps/$app`), never its URL.
reportUncaughtErrors(() => router.state.matches.at(-1)?.fullPath);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/**
 * The routes, mounted afresh in each language. The React Compiler caches
 * what a component computed from its props, and a label read with
 * `i18n._()` changes with the language, not with the props: without the
 * remount it would stay in the old language until the page reloads.
 */
export const Routes = () => {
  const { i18n: current } = useLingui();
  // Switching language re-runs the loaders, so what they put into words
  // (such as a source's name) is said in the new one. From the first
  // render on: the language the page started in is active by then. Not
  // the rest of a catalog joining its lean part (page-parts.ts), which
  // changes no word.
  useEffect(() => {
    let spoken = i18n.locale;
    return i18n.on("change", () => {
      if (i18n.locale !== spoken) {
        spoken = i18n.locale;
        void router.invalidate();
      }
    });
  }, []);
  return (
    <UiWords>
      <RouterProvider key={current.locale} router={router} />
    </UiWords>
  );
};
