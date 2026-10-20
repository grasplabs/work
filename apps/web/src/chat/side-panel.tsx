import type { App } from "@grasp-os/shared/apps";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { BoxIcon, CogIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useAppPanel } from "../screens/app-panel-context.tsx";
import { useCore } from "../use-core.ts";
import { ChatBuilds } from "./builds.tsx";
import type { ChatBuildsRead } from "./builds.tsx";

// Beside the chat: a slot for what the chat is about. The versions up for
// review of the Apps its agent builds (builds.tsx; the drafts themselves
// stand in the studio, studio.tsx), and the person's Apps, each opened in
// the shell's panel slot beside the page.

/** Why an App didn't open: it has nothing to show, or core didn't answer. */
const OpeningNote = ({ opening }: { opening: Loaded<string> }) =>
  opening.state === "ready" ? (
    <p className="text-muted-foreground text-sm">{opening.data}</p>
  ) : (
    <NotLoaded page={opening} />
  );

/**
 * The side panel: the versions of what the chat's agent built that wait
 * for review (`builds`, which the chat page reads), and the person's
 * Apps. Opening one opens its panel surface (spec 34.1) in the shell's
 * panel slot (screens/app-panel.tsx), or its first screen when it declares
 * none: there it stays while the page navigates. The Apps are read each
 * time the panel opens.
 */
export const SidePanel = ({ builds }: { builds: ChatBuildsRead }) => {
  const { t } = useLingui();
  const [apps, setApps] = useState<Loaded<App[]>>();
  const core = useCore();
  const panel = useAppPanel();
  const [opening, setOpening] = useState<Loaded<string> | undefined>();
  // Only the App opened last opens, whichever read ends last.
  const latest = useRef<App | null>(null);
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const found = await loadFromCore(
        core,
        async (session) => await session.apps.list()
      );
      if (current) {
        setApps(found);
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [core]);
  const open = async (app: App): Promise<void> => {
    latest.current = app;
    const found = await loadFromCore(core, async (session) => {
      const [contents, surfaces] = await Promise.all([
        session.apps.contents(app.id),
        session.screens.surfaces(app.id),
      ]);
      return { contents, surfaces };
    });
    if (latest.current !== app) {
      return;
    }
    if (found.state !== "ready") {
      setOpening(found);
      return;
    }
    const { contents, surfaces } = found.data;
    // Opened from here with nothing: a panel surface that takes nothing.
    const surface = surfaces.find(
      ({ kind, opensEmpty }) => kind === "panel" && opensEmpty
    );
    const [first] = contents.screens;
    if (surface !== undefined) {
      setOpening(undefined);
      panel?.open({
        app: app.id,
        screen: surface.screen,
        title: surface.title,
        route: surface.route,
        input: "{}",
        surface: surface.name,
      });
    } else if (first !== undefined && contents.version !== null) {
      setOpening(undefined);
      panel?.open({ app: app.id, screen: first, title: app.name });
    } else {
      const { name } = app;
      setOpening({ state: "ready", data: t`${name} has no app to show.` });
    }
  };
  if (apps === undefined) {
    return <LoadingLines />;
  }
  if (apps.state !== "ready") {
    return <NotLoaded page={apps} />;
  }
  return (
    <div className="flex flex-col gap-6">
      <ChatBuilds read={builds} />
      <section aria-labelledby="panel-apps" className="flex flex-col gap-2">
        <h2
          className="flex items-center gap-2 text-sm font-medium"
          id="panel-apps"
        >
          <CogIcon
            aria-hidden="true"
            className="text-muted-foreground size-4"
          />
          <Trans>Domains</Trans>
        </h2>
        {opening === undefined ? null : <OpeningNote opening={opening} />}
        {apps.data.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CogIcon />
              </EmptyMedia>
              <EmptyTitle>
                <Trans>No domains yet</Trans>
              </EmptyTitle>
              <EmptyDescription>
                <Trans>
                  Ask Grasp to build one. While it works, the domain stands
                  beside the chat, to preview before it is proposed.
                </Trans>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="-mx-2 flex flex-col gap-0.5">
            {apps.data.map((app) => (
              <li key={app.id}>
                <button
                  className="hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm outline-none focus-visible:ring-2"
                  onClick={() => {
                    void open(app);
                  }}
                  type="button"
                >
                  <BoxIcon
                    aria-hidden="true"
                    className="text-muted-foreground size-4 flex-none"
                  />
                  <span className="min-w-0 flex-1 truncate">{app.name}</span>
                  <ChevronRightIcon
                    aria-hidden="true"
                    className="text-muted-foreground size-4 flex-none"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
