import { createFileRoute } from "@tanstack/react-router";

// One of an App's own routes past its `/`, in the full page preview of
// its draft (apps.$app.draft.tsx draws the frame, whose router shows it):
// nothing of its own, so moving between the App's routes keeps the frame.

export const Route = createFileRoute("/apps/$app/draft/$")({
  component: () => null,
});
