import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
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

const styles = stylex.create({
  // A short column in the middle of the card, while the browser leaves.
  column: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
    width: "100%",
    maxWidth: "28rem",
    marginInline: "auto",
    padding: space["8"],
  },
});

const ConnectMicrosoft = () => {
  const page = Route.useLoaderData();
  return (
    <main {...stylex.props(styles.column)}>
      <Heading level={1} size="2xs">
        <Trans>Connecting your Microsoft 365</Trans>
      </Heading>
      {page.state === "ready" ? (
        <Text color="muted" size="sm">
          <Trans>Taking you to the Microsoft sign-in…</Trans>
        </Text>
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
          returnTo: "/connectors",
        })
    );
    if (page.state === "ready") {
      window.location.assign(page.data.url);
    }
    return page;
  },
});
