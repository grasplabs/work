import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { useDraft } from "../drafts/use-draft.ts";
import { useAppAddress } from "../pages/app-address.ts";
import { PreviewFrame } from "../pages/page-frame.tsx";

// The preview of an App's draft, full page, outside the shell: Open in a
// new tab over the workspace's preview links here, at the route it had
// open. As the App full page (apps.$app.full.tsx): its routes sit in the
// address, all under this one (apps.$app.draft.$.tsx draws nothing of
// its own, so moving between them keeps the frame), keyed by App, taking
// each write of the draft as the workspace's does. Core opens a preview
// to the App's builders alone.

const DraftPage = () => {
  const { app } = Route.useParams();
  const { t } = useLingui();
  const draft = `/apps/${app}/draft`;
  const address = useAppAddress({ root: draft, sub: draft });
  // Each write of the draft comes into the frame, as in the workspace.
  const { draft: read } = useDraft({ kind: "app", id: app }, 0);
  return (
    <main
      aria-label={t`Your version of the App`}
      className="flex h-svh flex-col"
    >
      <PreviewFrame
        bare={false}
        app={app}
        at={address.at}
        key={app}
        onMoved={address.handleMoved}
        ownPath={address.own}
        {...(read === undefined ? {} : { revision: read.revision })}
      />
    </main>
  );
};

export const Route = createFileRoute("/apps/$app/draft")({
  component: DraftPage,
});
