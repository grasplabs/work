import { createFileRoute } from "@tanstack/react-router";

import { ActivityPage } from "../brain/activity-page.tsx";

// Brain › Activity: what is new, what waits for an answer, then the
// brain's log, on the library's page (brain/activity-page.tsx).

export const Route = createFileRoute("/_shell/brain/activity")({
  component: ActivityPage,
});
