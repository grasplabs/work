import type { ChatDraft } from "@grasp-os/shared/chat";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { EyeIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { PreviewFrame } from "../pages/page-frame.tsx";
import type { PageEnded } from "../pages/page-frame.tsx";
import { useVersionPushes } from "../pages/use-version-pushes.ts";
import { changesApp } from "./builds.tsx";
import type { NamedDraft } from "./builds.tsx";
import { DraftVersionBar, shownVersion } from "./draft-versions.tsx";
import type { ShownVersion } from "./draft-versions.tsx";

// Building an App in a studio, as the prototype's (grasplabs/prototype
// `components/apps/app-studio.tsx`): the chat stands in the middle of the
// page until its agent has a draft to show; then the chat moves to the
// left and the draft's preview stands on the right, under a bar with the
// App's name and the way to the App itself. The bar is the App's own top
// row, as tall as the page sidebar's, so the two read as one line. On a
// narrow window the chat and the App take turns, chosen on top. Unlike
// the prototype's, what shows is the compiled page of core's draft, as
// a preview: it changes nothing and reads no real data.

/**
 * The preview of App `app` as the chat's `draft` has it: its pages, as
 * one single page app the person moves through as they would the App; of
 * the draft's earlier `version` when they opened one, read-only. With no
 * draft, or one that changes nothing, core previews the App's latest
 * version, so the App always shows. Each of the draft's writes comes into
 * the frame it has open, keeping what the pages hold and the route they
 * show, and starts afresh one that failed to start (page-frame.tsx);
 * another version starts it afresh, as its key says.
 */
export const DraftPreview = ({
  chatId,
  app,
  draft,
  name,
  version,
  onEnded,
  onShows,
}: {
  chatId: string;
  app: string;
  /** The chat's draft of the App; none before its first write. */
  draft: ChatDraft | undefined;
  name: string;
  version: number | undefined;
  /** Told once the frame failed (`PreviewFrame`). */
  onEnded?: PageEnded;
  /** Told the App's version the frame shows (`PreviewFrame`). */
  onShows?: (appVersion: number | undefined) => void;
}) => {
  const { t } = useLingui();
  return (
    <section
      aria-label={t`Preview of ${name}`}
      className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <PreviewFrame
        app={app}
        chatId={chatId}
        key={`${app}:${version ?? ""}`}
        {...(onShows === undefined ? {} : { onShows })}
        {...(draft === undefined ? {} : { revision: draft.revision })}
        {...(version === undefined ? {} : { version })}
        {...(onEnded === undefined ? {} : { onEnded })}
      />
    </section>
  );
};

/**
 * The App's top row: its name and which version of the chat's draft shows
 * (`DraftVersionBar`), then the way to the App, where its people meet it
 * (and an admin approves its pages' code). Its padding and the button's
 * height are the page sidebar's top row's (`PageSidebarTop`), so its line
 * continues that one. On a narrow screen the version controls wrap under
 * the name rather than run over the way to the App.
 */
const StudioBar = ({
  chatId,
  draft,
  name,
  headingId,
  version,
  onVersion,
}: {
  chatId: string;
  draft: ChatDraft;
  name: string;
  headingId: string;
  version: number | undefined;
  onVersion: (version?: number) => void;
}) => (
  <div className="flex flex-none items-center gap-3 border-b p-3">
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
      <h2 className="truncate font-medium" id={headingId}>
        {name}
      </h2>
      {changesApp(draft) ? (
        <DraftVersionBar
          chatId={chatId}
          draft={draft}
          onShow={onVersion}
          shown={version}
        />
      ) : null}
    </div>
    <Link
      className={buttonVariants({ variant: "outline" })}
      params={{ app: draft.app }}
      // The workspace carries this chat on, with the draft it builds.
      search={{ chat: chatId }}
      to="/apps/$app/edit"
    >
      <EyeIcon data-icon="inline-start" />
      <Trans>Open in the App&apos;s workspace</Trans>
    </Link>
  </div>
);

/** Which of the chat's drafts shows, when it writes more than one. */
const DraftPicker = ({
  drafts,
  shown,
  onPick,
}: {
  drafts: NamedDraft[];
  shown: string;
  onPick: (app: string) => void;
}) => {
  const { t } = useLingui();
  return (
    <fieldset className="flex flex-none flex-wrap gap-1 border-b px-3 py-2">
      <legend className="sr-only">{t`Apps being built in this chat`}</legend>
      {drafts.map(({ draft, name }) => (
        <Button
          aria-pressed={draft.app === shown}
          key={draft.app}
          onClick={() => {
            onPick(draft.app);
          }}
          size="sm"
          variant={draft.app === shown ? "secondary" : "ghost"}
        >
          {name}
        </Button>
      ))}
    </fieldset>
  );
};

type View = "chat" | "app";

/**
 * On a narrow window, which of the two shows: the chat or the App. Two
 * toggle buttons rather than tabs: the other pane stays in the page,
 * hidden, so the preview doesn't start again when it comes back.
 */
const ViewToggle = ({
  view,
  onView,
}: {
  view: View;
  onView: (view: View) => void;
}) => (
  <div className="flex flex-none gap-1 border-b p-2">
    <Button
      aria-pressed={view === "chat"}
      onClick={() => {
        onView("chat");
      }}
      size="sm"
      variant={view === "chat" ? "secondary" : "ghost"}
    >
      <Trans context="the chat beside an App being built">Chat</Trans>
    </Button>
    <Button
      aria-pressed={view === "app"}
      onClick={() => {
        onView("app");
      }}
      size="sm"
      variant={view === "app" ? "secondary" : "ghost"}
    >
      <Trans context="the App being built, beside its chat">App</Trans>
    </Button>
  </div>
);

/**
 * The chat (`children`) and, once its agent writes a draft, the App
 * beside it: the draft written last, or the one the person picked. Side
 * by side on a `wide` window; taking turns on a narrower one, the App
 * first. Hidden rather than gone while it is the other's turn, so the
 * preview doesn't start again.
 */
export const ChatStudio = ({
  chatId,
  drafts,
  wide,
  children,
}: {
  chatId: string;
  drafts: NamedDraft[];
  wide: boolean;
  children: ReactNode;
}) => {
  const [picked, setPicked] = useState<string>();
  const [opened, setOpened] = useState<ShownVersion>();
  const [view, setView] = useState<View>("app");
  // The drafts, by App, revision and the App's version pushes since,
  // whose preview had no App to show: changing nothing of an App with no
  // version (core's `app.not_running`). A write, or a version from
  // anywhere, shows it again.
  const [unbuilt, setUnbuilt] = useState<ReadonlySet<string>>(new Set());
  const pushes = useVersionPushes(drafts.map(({ draft }) => draft.app));
  const unbuiltKey = ({ app, revision }: ChatDraft): string =>
    `${app}:${revision}:${pushes[app] ?? 0}`;
  const headingId = useId();
  const shownDrafts = drafts.filter(
    ({ draft }) => !unbuilt.has(unbuiltKey(draft))
  );
  const shown =
    shownDrafts.find(({ draft }) => draft.app === picked) ?? shownDrafts[0];
  const version =
    shown === undefined ? undefined : shownVersion(shown.draft, opened);
  const studio = shown !== undefined;
  const chatShows = !studio || wide || view === "chat";
  let chatClass = "hidden";
  if (!studio) {
    chatClass = "flex min-h-0 w-full min-w-0 flex-col";
  } else if (chatShows) {
    chatClass =
      "flex min-h-0 w-full min-w-0 flex-col lg:w-104 lg:flex-none lg:border-r";
  }
  // One tree whether the App shows or not, so the chat isn't drawn anew,
  // losing where it was scrolled to, when the first draft comes.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {studio && !wide ? <ViewToggle onView={setView} view={view} /> : null}
      <div className="flex min-h-0 flex-1">
        <div className={chatClass}>{children}</div>
        {studio ? (
          <section
            aria-labelledby={headingId}
            className={
              wide || view === "app"
                ? "flex min-h-0 min-w-0 flex-1 flex-col"
                : "hidden"
            }
          >
            <StudioBar
              chatId={chatId}
              draft={shown.draft}
              headingId={headingId}
              name={shown.name}
              onVersion={(number) => {
                setOpened(
                  number === undefined
                    ? undefined
                    : {
                        app: shown.draft.app,
                        revision: shown.draft.revision,
                        number,
                      }
                );
              }}
              version={version}
            />
            {shownDrafts.length > 1 ? (
              <DraftPicker
                drafts={shownDrafts}
                onPick={setPicked}
                shown={shown.draft.app}
              />
            ) : null}
            {/* Framed on the studio's ground, as the workspace's fills its own. */}
            <div className="bg-muted flex min-h-0 flex-1 flex-col p-4">
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border">
                <DraftPreview
                  app={shown.draft.app}
                  chatId={chatId}
                  draft={shown.draft}
                  key={shown.draft.app}
                  name={shown.name}
                  onEnded={(ended) => {
                    if (
                      ended.status === "failed" &&
                      ended.reason === "not-running" &&
                      !changesApp(shown.draft)
                    ) {
                      const key = unbuiltKey(shown.draft);
                      setUnbuilt((before) => new Set([...before, key]));
                    }
                  }}
                  version={version}
                />
              </div>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
};
