import { cn } from "@grasp-os/ui/lib/utils";
import { Trans } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { AppLogo } from "./app-logo.tsx";
import { IntegrationsNerves, LINES } from "./integrations-nerves.tsx";
import type { NervePlace } from "./integrations-nerves.tsx";
import type { Integration } from "./integrations.ts";
import { stateOf } from "./integrations.ts";

// Ported from the prototype (grasplabs/prototype, packages/grasp:
// components/integrations-banner.tsx), reading Grasp OS's integrations: one
// is connected when anything is connected to it, and one that needs someone
// to sign in again still is, with a nerve that asks for it.

/** Where the nerve below the name sits too near the banner's top for the name to go over it, in pixels (`top-14`). */
const roomOver = 56;

/**
 * An app whose nerve glows: its name, where the pointer has its nerve in hand, and a link to it.
 * The place stays after the pointer leaves, so the name fades out where it stands.
 */
const SignInAgain = ({
  integration,
  place,
  shown,
}: {
  integration: Integration;
  place: NervePlace | undefined;
  shown: boolean;
}) => {
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const element = link.current;
    if (element === null) {
      return;
    }
    if (place === undefined) {
      element.style.removeProperty("--x");
      element.style.removeProperty("--y");
      return;
    }
    element.style.setProperty("--x", `${place.x}px`);
    element.style.setProperty("--y", `${place.y}px`);
  }, [place]);
  return (
    <Link
      className={cn(
        "bg-card focus-visible:ring-ring/50 absolute top-(--y,3.5rem) left-[clamp(7rem,var(--x,7rem),calc(100%-7rem))] flex -translate-x-1/2 items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm whitespace-nowrap shadow-xs transition-opacity outline-none focus-visible:opacity-100 focus-visible:ring-3",
        // Over the nerve, or under it where there is no room over it.
        place !== undefined && place.y < roomOver
          ? "translate-y-3"
          : "-translate-y-[calc(100%+0.75rem)]",
        shown ? "opacity-100" : "pointer-events-none opacity-0"
      )}
      data-line={integration.key}
      params={{ integration: integration.key }}
      ref={link}
      to="/integrations/$integration"
    >
      <AppLogo logo={integration.logo} name={integration.name} size="inline" />
      <span className="font-medium">{integration.name}</span>
      <span className="text-muted-foreground">
        <Trans>Sign in again</Trans>
      </span>
    </Link>
  );
};

/**
 * A band across the top of Integrations: the brain in the middle, in dots, and a nerve coming in
 * to it for every connected app, carrying its signals (`IntegrationsNerves`). Connect an app and
 * a nerve grows in; the brain takes `LINES` of them and no more. An app that needs signing in
 * again has a nerve that glows whole: with the pointer on it its name shows there, and a click
 * opens the app. Those names are links, so the keyboard reaches them too.
 */
export const IntegrationsBanner = ({
  integrations,
}: {
  integrations: Integration[];
}) => {
  const navigate = useNavigate();
  // The glowing nerve in hand, and where on each its app is named. The place is kept after the pointer leaves, so the name fades out where it stands.
  const [held, setHeld] = useState<string | null>(null);
  const [places, setPlaces] = useState<Record<string, NervePlace>>({});
  const connected = integrations
    .filter((integration) => stateOf(integration) !== "not_connected")
    .slice(0, LINES);
  const lines = connected.map((integration) => ({
    id: integration.key,
    attention: stateOf(integration) === "needs_reauth",
  }));
  return (
    <div className="banner-light relative h-44 overflow-hidden rounded-2xl border">
      <IntegrationsNerves
        lines={lines}
        onHold={(id, at) => {
          setHeld(id);
          if (id !== null && at !== undefined) {
            setPlaces((before) => ({ ...before, [id]: at }));
          }
        }}
        onOpen={(id) => {
          void navigate({
            to: "/integrations/$integration",
            params: { integration: id },
          });
        }}
      />
      {connected
        .filter((integration) => stateOf(integration) === "needs_reauth")
        .map((integration) => (
          <SignInAgain
            integration={integration}
            key={integration.key}
            place={places[integration.key]}
            shown={held === integration.key}
          />
        ))}
    </div>
  );
};
