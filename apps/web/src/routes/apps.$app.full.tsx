import { createFileRoute } from "@tanstack/react-router";

import { useAppAddress } from "../pages/app-address.ts";
import { PageFrame } from "../pages/page-frame.tsx";

// An App, full page, outside the shell: "Open full page" on the App's page
// links here, at the route it had open. Its routes sit in the address as
// on the App's page (pages/app-address.ts), all under this one
// (apps.$app.full.$.tsx draws nothing of its own, so moving between them
// keeps the frame). Keyed by App, so moving to another starts afresh: the
// chrome never shows the name of the App the page just left.

const FullPage = () => {
  const { app } = Route.useParams();
  const full = `/apps/${app}/full`;
  const address = useAppAddress({ root: full, sub: full });
  return (
    <main className="flex h-svh flex-col">
      <PageFrame
        app={app}
        at={address.at}
        key={app}
        onMoved={address.handleMoved}
        ownPath={address.own}
      />
    </main>
  );
};

export const Route = createFileRoute("/apps/$app/full")({
  component: FullPage,
});
