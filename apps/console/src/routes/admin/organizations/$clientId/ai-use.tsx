import { createFileRoute } from "@tanstack/react-router";

import { AiUse } from "../../../../admin/ai-use.tsx";

/** An organization's AI use: what it took, what that cost, and what did it. */
export const Route = createFileRoute("/admin/organizations/$clientId/ai-use")({
  component: AiUse,
});
