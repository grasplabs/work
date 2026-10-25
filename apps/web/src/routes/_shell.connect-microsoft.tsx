import { Trans } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// Where Stephen's card in a chat app sends someone to connect their own
// Microsoft 365 (core's channels/connect-own.ts). The link carries nothing
// of theirs: signed in to Grasp here (the shell sends them to sign in and
// back first), the page starts connect's sign-in for that person, asking
// what the company's classes need, and connect finishes it only for them.
// Once it finishes, core tells them in the chat app and carries on there;
// the browser lands on Integrations.

const ConnectMicrosoft = () => {
  const page = Route.useLoaderData();
  return (
    <main className="mx-auto flex max-w-md flex-col gap-3 p-8 text-sm">
      <h1 className="text-base font-medium">
        <Trans>Connecting your Microsoft 365</Trans>
      </h1>
      {page.state === "ready" ? (
        <p className="text-muted-foreground">
          <Trans>Taking you to the Microsoft sign-in…</Trans>
        </p>
      ) : (
        <NotLoadedState heading="h2" page={page} />
      )}
    </main>
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
