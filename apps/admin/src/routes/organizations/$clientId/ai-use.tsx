import { createFileRoute } from "@tanstack/react-router";

import { AiUse } from "../../../admin/ai-use.tsx";
import { OrganizationPlatformSpend } from "../../../admin/platform-spend.tsx";
import { fetchClientAiStatus } from "../../../clients/functions.ts";

const AiUsePage = () => {
  const { aiStatus } = Route.useLoaderData();
  return (
    <>
      <AiUse />
      <OrganizationPlatformSpend status={aiStatus} />
    </>
  );
};

/**
 * An organization's AI use: what it took, what that cost, and what did it;
 * then what Grasp's own AI features cost on Grasp's keys for it, read from
 * its core now (src/admin/platform-spend.tsx).
 */
export const Route = createFileRoute("/organizations/$clientId/ai-use")({
  loader: ({ params }) => {
    // Not awaited: a slow or unreachable core never holds up the page, and
    // a read that fails shows a line, never the route's error page.
    const aiStatus = (async () => {
      try {
        return await fetchClientAiStatus({
          data: { clientId: params.clientId },
        });
      } catch {
        return null;
      }
    })();
    return { aiStatus };
  },
  component: AiUsePage,
});
