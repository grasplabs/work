import { useLingui } from "@lingui/react/macro";

import { slotOf } from "../chat/chat-subject.ts";
import { Composer } from "../chat/composer.tsx";
import { useGlobalChat } from "../chat/global-chat.tsx";
import { useAsk } from "../chat/use-ask.ts";
import { ItemStart } from "../frame/item-shell.tsx";

// An App with no page yet, in its own shell (frame/item-shell.tsx): "What
// should this App do?", and the box to say it in, asked in the App's chat
// beside it. Something new is started from Make something, in a chat
// (make/make-link.tsx), never here.

/** An App with no page yet: what it should do, asked in the App's chat beside it. */
export const AppStart = ({ app }: { app: string }) => {
  const { t } = useLingui();
  const chat = useGlobalChat();
  const { composer } = useAsk(
    chat.chatId,
    chat.offered?.models,
    chat.offered?.efforts,
    slotOf({ kind: "app", id: app }),
    { subject: { kind: "app", id: app } }
  );
  return (
    <ItemStart
      composer={
        <Composer
          {...composer}
          label={t`Describe the App`}
          placeholder={t`An App that… (what it shows, and for whom)`}
          running={false}
        />
      }
      question={t`What should this App do?`}
    />
  );
};
