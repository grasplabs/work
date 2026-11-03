import { createFileRoute, redirect } from "@tanstack/react-router";

import { ScreenFrame } from "../screens/screen-frame.tsx";
import {
  useScreenNavigate,
  useScreenOpening,
} from "../screens/screen-navigate.ts";

// One of an App's pages (core's screens), full page, outside the frame:
// "Open full page" on the App's page links here, with the page in the
// address's `screen`, as on the App's page. Without one it opens the App's
// page, which opens its first. Keyed by App and page, so moving to another
// starts afresh: the chrome never shows the name of the App the page just
// left.

const FullPage = () => {
  const { app } = Route.useParams();
  const { screen } = Route.useSearch();
  const opening = useScreenOpening(app, screen);
  const navigate = useScreenNavigate(app, "/apps/$app/full");
  return (
    <main className="flex h-svh flex-col">
      <ScreenFrame
        app={app}
        key={`${app}/${screen}/${opening === undefined ? "" : JSON.stringify(opening)}`}
        onNavigate={navigate}
        screen={screen}
        {...(opening === undefined
          ? {}
          : {
              route: opening.route,
              input: opening.input,
              ...(opening.surface === undefined
                ? {}
                : { surface: opening.surface }),
            })}
      />
    </main>
  );
};

export const Route = createFileRoute("/apps/$app/full")({
  component: FullPage,
  validateSearch: (search: Record<string, unknown>): { screen: string } => ({
    screen: typeof search.screen === "string" ? search.screen : "",
  }),
  beforeLoad: ({ params, search }) => {
    if (search.screen === "") {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({
        to: "/apps/$app",
        params: { app: params.app },
        replace: true,
      });
    }
  },
});
