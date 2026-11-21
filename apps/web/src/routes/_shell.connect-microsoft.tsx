import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// Where Stephen's card in a chat app sends someone to connect their own
// Microsoft 365 (core's channels/connect-own.ts). The link carries nothing
// of theirs: signed in to Grasp here (the shell sends them to sign in and
// back first), the page starts connect's sign-in for that person, asking
// what the company's classes need, and connect finishes it only for them.
// Once it finishes, core tells them in the chat app and carries on there;
// the browser lands on Integrations.

// In the frame, under its own bar, as every page: the frame's <main> holds it.
const ConnectMicrosoft = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const title = t`Connecting your Microsoft 365`;
  return (
    <>
      <SiteHeader crumbs={[{ label: title }]} />
      <Page>
        <PageHeading
          title={title}
          {...(page.state === "ready"
            ? { description: t`Taking you to the Microsoft sign-in…` }
            : {})}
        />
        {page.state === "ready" ? null : (
          <NotLoadedState heading="h2" page={page} />
        )}
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/connect-microsoft")({
  component: ConnectMicrosoft,
  // Started as the page loads, once: a reload starts a new flow, as the
  // last one is spent or expires on its own.
  loader: async ({ context: { core } }) => {
    const page = await loadFromCore(
      core,
      async (session) =>
        await session.connections.start({
          provider: "microsoft",
          scope: "personal",
          returnTo: "/integrations",
        })
    );
    if (page.state === "ready") {
      window.location.assign(page.data.url);
    }
    return page;
  },
});
