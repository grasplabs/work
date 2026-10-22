import { createFileRoute } from "@tanstack/react-router";

import { ScreenFrame } from "../screens/screen-frame.tsx";
import {
  useScreenNavigate,
  useScreenOpening,
} from "../screens/screen-navigate.ts";

// One of an engine's apps (core's screens), full page, outside the frame:
// "Open full page" on the app's page in the frame links here. Core refuses
// the screen while the `screens` feature is off, and the page says so.
// Keyed by engine and app, so moving to another starts afresh: the chrome
// never shows the name of the engine the page just left.

const FullPage = () => {
  const { engine, screen } = Route.useParams();
  const opening = useScreenOpening(engine, screen);
  const navigate = useScreenNavigate(
    engine,
    "/domains/$engine/apps/$screen/full"
  );
  return (
    <main className="flex h-svh flex-col">
      <ScreenFrame
        app={engine}
        key={`${engine}/${screen}/${opening === undefined ? "" : JSON.stringify(opening)}`}
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

export const Route = createFileRoute("/domains/$engine/apps/$screen/full")({
  component: FullPage,
});
