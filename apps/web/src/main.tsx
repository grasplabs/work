import "./styles.css";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { Button } from "@grasp-os/ui/components/button";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import * as stylex from "@stylexjs/stylex";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { bootOf } from "./boot-path.ts";
import { reportError } from "./error-reports.ts";
import { startI18n } from "./i18n.ts";
import { partAt } from "./lean-pages.ts";
import { loadStartStyles } from "./page-parts.ts";

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

const styles = stylex.create({
  // The one line and its button, in the middle of the window.
  noWords: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space["4"],
    minHeight: "100svh",
    padding: space["6"],
    textAlign: "center",
  },
});

/**
 * When not even English's words, the page's own code or a lean page's
 * stylesheet could be fetched (the connection dropped as Grasp loaded),
 * there is one thing left to say, and only English to say it in.
 */
const NoWords = () => (
  <main {...stylex.props(styles.noWords)}>
    <Text color="muted" size="sm">
      Grasp could not load. Check your connection and try again.
    </Text>
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
 * the language. A lean page (lean-pages.ts) loads only its part of the
 * catalog, and its stylesheet, here; any other, the whole of both as the
 * root route loads (page-parts.ts). A function, not a top-level `await`: a module that awaits
 * at its top level keeps the bundler from merging the modules it imports,
 * and the build split into hundreds of tiny files.
 */
const start = async (): Promise<void> => {
  const part = partAt(window.location.pathname);
  let worded = true;
  try {
    await Promise.all([startI18n(part), loadStartStyles(part)]);
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
