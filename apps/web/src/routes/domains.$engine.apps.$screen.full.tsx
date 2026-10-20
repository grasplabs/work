import { createFileRoute } from "@tanstack/react-router";

import { ScreenFrame } from "../screens/screen-frame.tsx";
import {
  screenSearchSchema,
  useScreenNavigate,
} from "../screens/screen-navigate.ts";

// One of an engine's apps (core's screens), full page, outside the frame:
// "Open full page" on the app's page in the frame links here. Core refuses
// the screen while the `screens` feature is off, and the page says so.
// Keyed by engine and app, so moving to another starts afresh: the chrome
// never shows the name of the engine the page just left.

const FullPage = () => {
  const { engine, screen } = Route.useParams();
  const { route, input } = Route.useSearch();
  const navigate = useScreenNavigate(
    engine,
    "/domains/$engine/apps/$screen/full"
  );
  return (
    <main className="flex h-svh flex-col">
      <ScreenFrame
        app={engine}
        key={`${engine}/${screen}/${route ?? ""}/${input ?? ""}`}
        onNavigate={navigate}
        screen={screen}
        {...(route === undefined ? {} : { route })}
        {...(input === undefined ? {} : { input })}
      />
    </main>
  );
};

export const Route = createFileRoute("/domains/$engine/apps/$screen/full")({
  component: FullPage,
  validateSearch: screenSearchSchema,
});
