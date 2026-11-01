import { createFileRoute } from "@tanstack/react-router";

import { BrainLog } from "../brain/brain-log.tsx";

// Brain › Activity: the brain's log, day by day, as the prototype has it
// (`routes/brain/activity.tsx`).

export const Route = createFileRoute("/_shell/brain/activity")({
  component: BrainLog,
});
