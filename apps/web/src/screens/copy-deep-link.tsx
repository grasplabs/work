import type { SurfaceSummary } from "@grasp-os/shared/screens";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { toast } from "@grasp-os/ui/components/toast";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { LinkIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { loadFromCore } from "../load-from-core.tsx";
import { copyText } from "../onboarding/setup-parts.tsx";
import { useCore } from "../use-core.ts";

// "Copy link" on an App's screen: the App's deep links to this screen
// (surfaces of kind `deepLink`, spec 34.1), as `/links/<app>/<surface>` on
// this workspace's own address, the one the page was served from. Only a
// deep link that opens with nothing is offered: a copied link carries no
// input. Anyone may be sent one; opening it has them signed in, and core
// checks the App declares the link and that they may open it, so copying
// grants nothing. Nothing shows when the screen has no such link.

/** This screen's deep links that open with nothing, as core lists them. */
const linksOf = (
  surfaces: readonly SurfaceSummary[],
  screen: string
): SurfaceSummary[] =>
  surfaces.filter(
    (surface) =>
      surface.kind === "deepLink" &&
      surface.screen === screen &&
      surface.opensEmpty
  );

/** The deep links of `screen` in `app`, to copy. */
export const CopyDeepLink = ({
  app,
  screen,
}: {
  app: string;
  screen: string;
}) => {
  const core = useCore();
  const router = useRouter();
  const { t } = useLingui();
  const [links, setLinks] = useState<SurfaceSummary[]>([]);
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const loaded = await loadFromCore(
        core,
        async (session) => await session.screens.surfaces(app),
        left.signal
      );
      if (!left.signal.aborted && loaded.state === "ready") {
        setLinks(linksOf(loaded.data, screen));
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [app, core, screen]);
  const copy = async (surface: SurfaceSummary): Promise<void> => {
    const { href } = router.buildLocation({
      to: "/links/$app/$surface",
      params: { app, surface: surface.name },
    });
    const link = new URL(href, window.location.origin).href;
    const { title } = surface;
    if (await copyText(link)) {
      toast.add({ type: "success", title: t`Link to ${title} copied` });
    } else {
      toast.add({
        type: "error",
        title: t`Couldn't copy the link`,
        description: link,
      });
    }
  };
  const [only] = links;
  if (only === undefined) {
    return null;
  }
  if (links.length === 1) {
    return (
      <Button
        onClick={() => {
          void copy(only);
        }}
        size="sm"
        variant="outline"
      >
        <LinkIcon data-icon="inline-start" />
        <Trans>Copy link</Trans>
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
        <LinkIcon data-icon="inline-start" />
        <Trans>Copy link</Trans>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {links.map((surface) => (
          <DropdownMenuItem
            key={surface.name}
            onClick={() => {
              void copy(surface);
            }}
          >
            {surface.title}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
