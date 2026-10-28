import { appLinkSchema } from "@grasp-os/shared/apps";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { PageLoading, NotFound } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// Any address no page has, for someone signed in: an App's own link
// (core's app-own-links.ts) when it is one they may open, its page then;
// otherwise not found, in the frame, with the sidebar beside it to go on
// from. Tried only here, so a link never stands for a page.
export const Route = createFileRoute("/_shell/$")({
  pendingComponent: PageLoading,
  component: () => <NotFound />,
  loader: async ({ context: { core }, params }) => {
    const link = appLinkSchema.safeParse(params._splat);
    if (!link.success) {
      return;
    }
    const opened = await loadFromCore(
      core,
      async (session) => await session.apps.openLink(link.data)
    );
    if (opened.state === "ready") {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({
        replace: true,
        to: "/apps/$app",
        params: { app: opened.data.app },
      });
    }
  },
});
