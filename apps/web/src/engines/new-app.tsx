import { appLimits } from "@grasp-os/shared/app-limits";
import type { ModelEfforts } from "@grasp-os/shared/models";
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import type { ReactNode } from "react";

import { appSlot, setActiveChat } from "../chat/active-chat.ts";
import { Composer } from "../chat/composer.tsx";
import { useAsk } from "../chat/use-ask.ts";
import type { Session } from "../core.ts";

// A new App: one big box, "What do you want to build?". What the person
// writes makes the App (named after its first line) with its own chat
// (`chats.newApp`), asks it there as the first question, and lands in the
// App's workspace (app-workspace.tsx), where the chat on the right builds
// it and the preview shows it as it comes. Below the box, other ways to
// start (`children`), such as from a blueprint.

/** A new App's name: the first line of what was asked, cut to fit. */
export const nameOf = (question: string): string => {
  const line = question.trim().split("\n")[0]?.trim() ?? "";
  const most = appLimits.nameLength;
  return line.length > most ? `${line.slice(0, most - 1)}…` : line;
};

/** A new App's description: what was asked, cut to fit. */
const descriptionOf = (question: string): string =>
  question.trim().slice(0, appLimits.descriptionLength);

export const NewApp = ({
  models,
  efforts,
  children,
}: {
  models: string[];
  efforts: Record<string, ModelEfforts>;
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  // The App made for the question: asking again after a send that failed
  // asks in its chat, rather than making another App.
  const made = useRef<{ app: string; chat: string } | null>(null);
  const textRef = useRef("");
  const { composer } = useAsk(undefined, models, efforts, "here", undefined, {
    chatFor: async (session: Session) => {
      // Made with its chat. Kept as soon as it is made: a retry after its
      // question failed asks in this App, never making another.
      if (made.current === null) {
        const chat = await session.chats.newApp({
          name: nameOf(textRef.current),
          description: descriptionOf(textRef.current),
        });
        made.current = { app: chat.appId, chat: chat.id };
      }
      return made.current.chat;
    },
    onAsked: (chatId) => {
      const app = made.current?.app;
      if (app === undefined) {
        return;
      }
      setActiveChat(chatId, appSlot(app));
      void navigate({ to: "/apps/$app/edit", params: { app } });
    },
  });
  return (
    <section
      aria-labelledby="new-app"
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="flex min-h-full items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-3xl flex-col gap-8 pb-10">
          <PageHeaderTitle className="text-center" id="new-app">
            <Trans>What do you want to build?</Trans>
          </PageHeaderTitle>
          <Composer
            {...composer}
            label={t`Describe the App`}
            onSend={() => {
              textRef.current = composer.text;
              composer.onSend();
            }}
            placeholder={t`An App that… (what it shows, and for whom)`}
            running={false}
          />
          {children}
        </div>
      </div>
    </section>
  );
};
