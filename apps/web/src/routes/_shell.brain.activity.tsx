import { createFileRoute } from "@tanstack/react-router";

import { BrainLog } from "../brain/brain-log.tsx";

// Brain › Activity: the brain's log, day by day, as the prototype has it
// (`routes/brain/activity.tsx`).

const Activity = () => {
  const { concept } = Route.useSearch();
  return <BrainLog concept={concept} />;
};

export const Route = createFileRoute("/_shell/brain/activity")({
  // Concepts for Ruben (concept branch only): ?concept=b or ?concept=c.
  validateSearch: (search: Record<string, unknown>): { concept?: string } =>
    typeof search.concept === "string" ? { concept: search.concept } : {},
  component: Activity,
});
