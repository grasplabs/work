import { createFileRoute } from "@tanstack/react-router";

// One of an App's own routes past its `/` (pages/app-address.ts): the
// App's page (_shell.apps.$app.tsx) draws its frame, whose router shows
// the route; this draws nothing, so moving between the App's routes
// keeps that page and its frame as they are.

export const Route = createFileRoute("/_shell/apps/$app/pages/$")({
  component: () => null,
});
