import "./styles.css";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { Button } from "@grasp-os/app-kit/components/button";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { bootOf } from "./boot-path.ts";
import { reportError } from "./error-reports.ts";
import { startI18n } from "./i18n.ts";

// The one file every page loads: it asks for the page's routes at once,
// alongside its language. At an interview link that is the interview
// alone (interview-routes.tsx), so the people who take one wait for
// nothing of the app they never see; everywhere else, the whole app
// (app-routes.tsx). What fails to arrive is said as words that do not.
const loadRoutes = async () => {
  try {
    return bootOf(window.location.pathname) === "interview"
      ? await import("./interview-routes.tsx")
      : await import("./app-routes.tsx");
  } catch {
    return null;
  }
};
const routes = loadRoutes();

const root = document.querySelector("#root");
if (!root) {
  throw new Error("Missing #root element");
}

/**
 * When not even English's words, or the page's own code, could be fetched
 * (the connection dropped as Grasp loaded), there is one thing left to
 * say, and only English to say it in.
 */
const NoWords = () => (
  <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
    <p className="text-muted-foreground text-sm">
      Grasp could not load. Check your connection and try again.
    </p>
    <Button
      onClick={() => {
        window.location.reload();
      }}
      variant="outline"
    >
      Try again
    </Button>
  </main>
);

/**
 * The language first, then the page: every message on it is looked up in
 * the language. A function, not a top-level `await`: a module that awaits
 * at its top level keeps the bundler from merging the modules it imports,
 * and the build split into hundreds of tiny files.
 */
const start = async (): Promise<void> => {
  let worded = true;
  try {
    await startI18n();
  } catch {
    worded = false;
  }
  const loaded = await routes;

  // What no route's boundary caught, such as a fault in the router itself.
  createRoot(root, {
    onUncaughtError: (error) => {
      void reportError("render", error);
    },
  }).render(
    <StrictMode>
      {/* Base UI renders no <style> of its own: the kit's styles.css
          carries the rule it held. */}
      <CSPProvider disableStyleElements>
        {/* Lingui draws nothing until a language is active. */}
        {worded && loaded !== null ? (
          <I18nProvider i18n={i18n}>
            <loaded.Routes />
          </I18nProvider>
        ) : (
          <NoWords />
        )}
      </CSPProvider>
    </StrictMode>
  );
};

void start();
