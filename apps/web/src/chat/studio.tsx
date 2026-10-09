import type { ChatDraft } from "@grasp-os/shared/chat";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { EyeIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { PreviewFrame } from "../screens/screen-frame.tsx";
import { changedScreens, previewedScreen } from "./builds-state.ts";
import type { NamedDraft } from "./builds.tsx";

// Building an App in a studio, as the prototype's (grasplabs/prototype
// `components/apps/app-studio.tsx`): the chat stands in the middle of the
// page until its agent has a draft to show; then the chat moves to the
// left and the draft's preview stands on the right, under a bar with the
// App's name and the way to the App itself. The bar is the App's own top
// row, as tall as the page sidebar's, so the two read as one line. On a
// narrow window the chat and the App take turns, chosen on top. Unlike
// the prototype's, what shows is the compiled screen of core's draft, as
// a preview: it changes nothing and reads no real data.

/**
 * The preview of a draft: its first screen, or one it changes the person
 * picks. Loaded afresh at each of the draft's writes, as its key says.
 */
const DraftPreview = ({
  chatId,
  draft,
  name,
}: {
  chatId: string;
  draft: ChatDraft;
  name: string;
}) => {
  const [picked, setPicked] = useState<string>();
  const { t } = useLingui();
  const screens = changedScreens(draft);
  const screen = previewedScreen(screens, picked);
  return (
    <section
      aria-label={t`Preview of ${name}`}
      className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border"
    >
      {screens.length > 1 ? (
        <div className="flex flex-wrap gap-1 border-b p-2">
          {screens.map((one) => (
            <Button
              aria-pressed={one === screen}
              key={one}
              onClick={() => {
                setPicked(one);
              }}
              size="sm"
              variant={one === screen ? "secondary" : "ghost"}
            >
              {one}
            </Button>
          ))}
        </div>
      ) : null}
      <PreviewFrame
        app={draft.app}
        chatId={chatId}
        key={`${draft.app}:${draft.revision}:${screen ?? ""}`}
        {...(screen === undefined ? {} : { screen })}
      />
    </section>
  );
};

/**
 * The App's top row: its name and how much the chat changed of it, then
 * the way to the App, where its people meet it (and an admin approves its
 * screens' code). Its padding and the button's height are the page
 * sidebar's top row's (`PageSidebarTop`), so its line continues that one.
 */
const StudioBar = ({
  draft,
  name,
  headingId,
}: {
  draft: ChatDraft;
  name: string;
  headingId: string;
}) => (
  <div className="flex flex-none items-center gap-3 border-b p-3">
    <div className="flex min-w-0 flex-1 items-baseline gap-2">
      <h2 className="truncate font-medium" id={headingId}>
        {name}
      </h2>
      <span className="text-muted-foreground truncate text-xs max-sm:hidden">
        <Plural
          one="# file changed in this chat, not proposed yet"
          other="# files changed in this chat, not proposed yet"
          value={draft.changed.length}
        />
      </span>
    </div>
    <Link
      className={buttonVariants({ variant: "outline" })}
      params={{ engine: draft.app }}
      to="/engines/$engine"
    >
      <EyeIcon data-icon="inline-start" />
      <Trans>View app</Trans>
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

/** On a narrow window, which of the two shows: the chat or the App. */
const ViewTabs = ({
  view,
  onView,
}: {
  view: View;
  onView: (view: View) => void;
}) => (
  <div className="flex-none border-b p-2">
    <Tabs
      onValueChange={(value: View) => {
        onView(value);
      }}
      value={view}
    >
      <TabsList>
        <TabsTrigger value="chat">
          <Trans context="the chat beside an App being built">Chat</Trans>
        </TabsTrigger>
        <TabsTrigger value="app">
          <Trans context="the App being built, beside its chat">App</Trans>
        </TabsTrigger>
      </TabsList>
    </Tabs>
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
  const [view, setView] = useState<View>("app");
  const headingId = useId();
  const shown = drafts.find(({ draft }) => draft.app === picked) ?? drafts[0];
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
      {studio && !wide ? <ViewTabs onView={setView} view={view} /> : null}
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
              draft={shown.draft}
              headingId={headingId}
              name={shown.name}
            />
            {drafts.length > 1 ? (
              <DraftPicker
                drafts={drafts}
                onPick={setPicked}
                shown={shown.draft.app}
              />
            ) : null}
            <div className="bg-muted flex min-h-0 flex-1 flex-col p-4">
              <DraftPreview
                chatId={chatId}
                draft={shown.draft}
                key={shown.draft.app}
                name={shown.name}
              />
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
};
