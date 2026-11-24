import { createFileRoute } from "@tanstack/react-router";

// One of an App's own routes past its `/`, full page (apps.$app.full.tsx
// draws the frame, whose router shows it): nothing of its own, so moving
// between the App's routes keeps the frame as it is.

export const Route = createFileRoute("/apps/$app/full/$")({
  component: () => null,
});
