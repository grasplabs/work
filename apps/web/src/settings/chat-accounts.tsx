import { agentErrors } from "@grasp-os/shared/agent";
import type {
  ChannelAccount,
  ChannelLinkPreview,
  ChannelLinkRefusal,
  ChannelReach,
} from "@grasp-os/shared/channel-accounts";
import { chatPlatformName } from "@grasp-os/shared/chat";
import { failureText } from "@grasp-os/shared/errors";
import { Button } from "@grasp-os/ui/components/button";
import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Icon, MessageCircleIcon } from "@grasp-os/ui/lib/icons";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { forgetChatLink } from "./chat-link.ts";
import { ConfirmAction } from "./confirm-action.tsx";
import { RowNote, SettingRow, SettingsGroup, ItemList } from "./section.tsx";

// Settings › Security: the person's accounts on chat platforms that are
// linked to them, so Grasp knows it is them writing there, as quiet rows in
// the Chat apps card (none when none are); where they reach Stephen, in
// each chat app the deployment set up that he answers them in; and a link
// a chat sent them, waiting for them to confirm it, as an outlined row
// above that card. Confirming is a press here, never opening the link
// (chat apps open links to preview them), and the card says whose account
// it is, by the platform's own name for it, so a link someone forwarded
// doesn't pass for theirs. And deleting what Grasp keeps of their
// conversations with Stephen there, which no page of Grasp shows as a chat
// (GRA-1919): this is where the person erases them.

/** Where Stephen is reached, the linked accounts, and the link waiting in this tab, if any. */
export interface ChatAccounts {
  reach: ChannelReach[];
  accounts: ChannelAccount[];
  pending?: { secret: string; preview: ChannelLinkPreview };
}

/** Why a link links nothing, in the page's language. */
const useRefusalText = (reason: ChannelLinkRefusal): string => {
  const { t } = useLingui();
  switch (reason) {
    case "not_found": {
      return t`This link isn’t one Grasp sent. Write to Grasp in the chat app for a new one.`;
    }
    case "used": {
      return t`This link has been used already. Each link works once.`;
    }
    case "expired": {
      return t`This link has expired. Write to Grasp in the chat app for a new one.`;
    }
    case "replaced": {
      return t`A newer link was sent since. Open the latest one from the chat app.`;
    }
    case "taken": {
      return t`This chat account is linked to someone else. They need to unlink it first.`;
    }
    default: {
      return reason satisfies never;
    }
  }
};

/** A link that links nothing, and a way to put it away. */
const RefusedLink = ({ reason }: { reason: ChannelLinkRefusal }) => {
  const { t } = useLingui();
  const router = useRouter();
  const text = useRefusalText(reason);
  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>{t`This link can’t be used`}</ItemTitle>
        <ItemDescription>{text}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          onClick={() => {
            forgetChatLink();
            void router.invalidate();
          }}
          size="sm"
          variant="ghost"
        >
          {t`Dismiss`}
        </Button>
      </ItemActions>
    </Item>
  );
};

/** A link a chat sent, waiting for the person to say the account is theirs. */
const OpenLink = ({
  secret,
  platform,
  platformUserId,
  name,
}: {
  secret: string;
  platform: string;
  platformUserId: string;
  name: string | null;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const app = chatPlatformName(platform);
  const account = name ?? platformUserId;
  const link = async (): Promise<void> => {
    await run(async ({ channelAccounts }) => {
      await changeThenRefresh(
        async () => {
          const answer = await channelAccounts.link(secret);
          // A refusal keeps the link: the refreshed preview says why. Once
          // linked, the card goes and the account stands among the linked.
          if (answer.state === "linked") {
            forgetChatLink();
          }
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <Item variant="outline">
      <ItemMedia variant="icon">
        <Icon icon={MessageCircleIcon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{t`Link your ${app} account ${account}?`}</ItemTitle>
        <ItemDescription>
          <RowNote failure={failure}>
            {t`Grasp sent this link to that account in ${app}. Link it only if it is yours: Grasp then answers it as you, with what you can see.`}
          </RowNote>
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          disabled={busy}
          onClick={() => {
            forgetChatLink();
            void router.invalidate();
          }}
          size="sm"
          variant="ghost"
        >
          {t`Not mine`}
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            void link();
          }}
          size="sm"
        >
          {t`Link`}
        </Button>
      </ItemActions>
    </Item>
  );
};

/** One linked account, and unlinking it. */
const AccountRow = ({ account }: { account: ChannelAccount }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const app = chatPlatformName(account.platform);
  const shown = account.name ?? account.platformUserId;
  const unlink = async (): Promise<void> => {
    await run(async ({ channelAccounts }) => {
      await changeThenRefresh(
        async () => await channelAccounts.unlink(account.id),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <Item size="xs">
      <ItemMedia variant="icon">
        <Icon icon={MessageCircleIcon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{shown}</ItemTitle>
        <ItemDescription>
          <RowNote failure={failure}>{app}</RowNote>
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          aria-label={t`Unlink ${app} account ${shown}`}
          disabled={busy}
          onClick={() => {
            void unlink();
          }}
          size="sm"
          variant="ghost"
        >
          {t`Unlink`}
        </Button>
      </ItemActions>
    </Item>
  );
};

/** Where to find Stephen in `platform`, in the page's language. */
const useFindText = (platform: ChannelReach["platform"]): string => {
  const { t } = useLingui();
  return platform === "teams"
    ? t`Open a chat with Stephen, or search for him in Teams’ apps.`
    : t`Find Stephen under Apps in your Slack workspace.`;
};

/** One chat app he answers the person in: where to find him, and a link that opens it where there is one. */
const ReachRow = ({ reach }: { reach: ChannelReach }) => {
  const { t } = useLingui();
  const app = chatPlatformName(reach.platform);
  const find = useFindText(reach.platform);
  return (
    <Item size="xs">
      <ItemMedia variant="icon">
        <Icon icon={MessageCircleIcon} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{app}</ItemTitle>
        <ItemDescription>{find}</ItemDescription>
      </ItemContent>
      {reach.href === null ? null : (
        <ItemActions>
          <Button asChild size="sm" variant="outline">
            <a
              aria-label={t`Open Stephen in ${app}, in a new tab`}
              href={reach.href}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t`Open`}
            </a>
          </Button>
        </ItemActions>
      )}
    </Item>
  );
};

/**
 * How many of the person's conversations in chat apps were deleted, or
 * why none could go yet: one is still being answered, or an earlier
 * delete is under way. Outside the component, as the React Compiler
 * can't compile `try`.
 */
const forgotten = async (
  session: Session
): Promise<number | "answering" | "under_way"> => {
  try {
    return await session.channelAccounts.forgetConversations();
  } catch (error) {
    const code = agentErrors.codeOf(error);
    if (code === "agent.conversation_answering") {
      return "answering";
    }
    if (code === "agent.delete_under_way") {
      return "under_way";
    }
    throw error;
  }
};

/**
 * Deleting what Grasp keeps of every conversation the person had with
 * Stephen in a chat app (`channelAccounts.forgetConversations`), and how
 * many it deleted, said under the row once it went.
 */
const ForgetConversations = () => {
  const { t } = useLingui();
  const core = useCore();
  const [deleted, setDeleted] = useState<number | "answering" | "under_way">();
  // Core's own reason, when it refused for another one.
  const [failure, setFailure] = useState<string>();
  const refusals = {
    answering: t`Stephen is still answering one of your conversations. Try again in a moment.`,
    under_way: t`Your conversations are being deleted. If any remain, try again in a moment.`,
  };
  const went =
    typeof deleted === "number"
      ? t`${plural(deleted, { 0: "No conversations to delete.", one: "# conversation deleted.", other: "# conversations deleted." })}`
      : t`Grasp keeps what you say to Stephen in a chat app, so he can follow the conversation and learn from it.`;
  return (
    <SettingRow
      {...(typeof deleted === "string" ? { error: refusals[deleted] } : {})}
      {...(failure === undefined ? {} : { error: failure })}
      help={went}
      label={t`Your conversations in chat apps`}
    >
      <ConfirmAction
        action={async () => {
          setDeleted(undefined);
          setFailure(undefined);
          try {
            setDeleted(await core.withSession(forgotten));
          } catch (error) {
            setFailure(failureText(error));
            throw error;
          }
        }}
        description={t`Grasp deletes what it keeps of every conversation you had with Stephen in a chat app, and what your Brain kept from them. He starts afresh the next time you write. The messages stay in the chat app itself. This can't be undone.`}
        errorLabel={t`Not deleted`}
        label={t`Delete for good`}
        loadingLabel={t`Deleting`}
        title={t`Delete your conversations in chat apps?`}
        trigger={
          <Button size="sm" variant="secondary">
            {t`Delete`}
          </Button>
        }
      />
    </SettingRow>
  );
};

/**
 * A link a chat app sent, waiting in this tab for the person to confirm or
 * turn down; or why the accounts could not be read to show it.
 */
const PendingChatLink = ({ chat }: { chat: Loaded<ChatAccounts> }) => {
  if (chat.state !== "ready") {
    return <NotLoadedState heading="h3" page={chat} />;
  }
  const { pending } = chat.data;
  if (pending === undefined) {
    return null;
  }
  const { preview, secret } = pending;
  return preview.state === "refused" ? (
    <RefusedLink reason={preview.reason} />
  ) : (
    <OpenLink
      name={preview.offer.name}
      platform={preview.offer.platform}
      platformUserId={preview.offer.platformUserId}
      secret={secret}
    />
  );
};

/**
 * Chat apps: the link a chat app sent, while one waits in this tab, as an
 * outlined row above the card; in the card, deleting the person's
 * conversations with Stephen there, then where they reach him, then the
 * accounts linked to them.
 */
export const ChatAppsSection = ({
  chat,
  waiting,
}: {
  chat: Loaded<ChatAccounts>;
  waiting: boolean;
}) => {
  const { t } = useLingui();
  const ready = chat.state === "ready" ? chat.data : undefined;
  return (
    <>
      {waiting ? <PendingChatLink chat={chat} /> : null}
      <SettingsGroup title={t`Chat apps`}>
        <FieldGroup>
          <ForgetConversations />
        </FieldGroup>
        {ready === undefined || ready.reach.length === 0 ? null : (
          <ItemList aria-label={t`Where to reach Stephen`}>
            {ready.reach.map((one) => (
              <ReachRow key={one.platform} reach={one} />
            ))}
          </ItemList>
        )}
        {ready === undefined || ready.accounts.length === 0 ? null : (
          <ItemList aria-label={t`Linked chat accounts`}>
            {ready.accounts.map((account) => (
              <AccountRow account={account} key={account.id} />
            ))}
          </ItemList>
        )}
      </SettingsGroup>
    </>
  );
};
