import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";

import type { AppCardSignal } from "../grasp/app-card/index.ts";
import { useAppAddress } from "../pages/app-address.ts";
import { PageFrame } from "../pages/page-frame.tsx";

// An App, full page, outside the shell: "Open full page" on the App's page
// links here, at the route it had open. Its routes sit in the address as
// on the App's page (pages/app-address.ts), all under this one
// (apps.$app.full.$.tsx draws nothing of its own, so moving between them
// keeps the frame). Keyed by App, so moving to another starts afresh: the
// chrome never shows the name of the App the page just left.
//
// The Apps page shows this page in each App card's window. There it has
// no bar (the card names the App), and it tells the card once the App has
// drawn or failed, so the card keeps its skeleton until then and never
// shows a blank or broken page (AppCardLive's `ready: "message"`).

const page = stylex.create({
  // The frame fills the window: the App's page scrolls inside it.
  main: { display: "flex", flexDirection: "column", height: "100svh" },
});

/** The card this page stands in, if it stands in one: a page of our own site framing it. */
const cardOf = (): Window | undefined => {
  if (window.parent === window) {
    return undefined;
  }
  try {
    // Readable only from our own site: any other parent is no card of ours.
    return window.parent.location.origin === window.location.origin
      ? window.parent
      : undefined;
  } catch {
    return undefined;
  }
};

/** Tells the card this page stands in how the App stands. */
const tellCard = (card: Window, state: AppCardSignal["state"]): void => {
  const signal: AppCardSignal = { type: "app-card", state };
  card.postMessage(signal, window.location.origin);
};

const FullPage = () => {
  const { app } = Route.useParams();
  const full = `/apps/${app}/full`;
  const address = useAppAddress({ root: full, sub: full });
  const card = cardOf();
  return (
    <main {...stylex.props(page.main)}>
      <PageFrame
        app={app}
        at={address.at}
        key={app}
        onMoved={address.handleMoved}
        ownPath={address.own}
        {...(card === undefined
          ? {}
          : {
              bare: true,
              onRunning: () => {
                tellCard(card, "ready");
              },
              onEnded: () => {
                tellCard(card, "failed");
              },
            })}
      />
    </main>
  );
};

export const Route = createFileRoute("/apps/$app/full")({
  component: FullPage,
});
