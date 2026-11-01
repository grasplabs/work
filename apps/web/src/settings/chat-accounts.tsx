import type {
  ChannelAccount,
  ChannelLinkPreview,
  ChannelLinkRefusal,
} from "@grasp-os/shared/channel-accounts";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { MessageSquareIcon } from "lucide-react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { platformName } from "../chat-platforms.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { forgetChatLink } from "./chat-link.ts";
import { SettingsBody, SettingsSection } from "./settings-parts.tsx";

// Settings › Security › Chat apps: the person's accounts on chat platforms
// that are linked to them, so Grasp knows it is them writing there, and a
// link a chat sent them, waiting for them to confirm it. Confirming is a
// press here, never opening the link (chat apps open links to preview
// them), and the card says whose account it is, by the platform's own
// name for it, so a link someone forwarded doesn't pass for theirs.

/** What the section shows: the linked accounts, and the link waiting, if any. */
export interface ChatAccounts {
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
  const router = useRouter();
  const text = useRefusalText(reason);
  return (
    <Alert>
      <AlertTitle>
        <Trans>This link can’t be used</Trans>
      </AlertTitle>
      <AlertDescription>{text}</AlertDescription>
      <AlertAction>
        <Button
          onClick={() => {
            forgetChatLink();
            void router.invalidate();
          }}
          size="sm"
          variant="ghost"
        >
          <Trans>Dismiss</Trans>
        </Button>
      </AlertAction>
    </Alert>
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
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const app = platformName(platform);
  const account = name ?? platformUserId;
  const link = async (): Promise<void> => {
    await run(async ({ channelAccounts }) => {
      await changeThenRefresh(
        async () => {
          const outcome = await channelAccounts.link(secret);
          // A refusal keeps the link: the refreshed preview says why.
          if (outcome.state === "linked") {
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
    <Alert>
      <AlertTitle>
        <Trans>
          Link your {app} account {account}?
        </Trans>
      </AlertTitle>
      <AlertDescription>
        <Trans>
          Grasp sent this link to that account in {app}. Link it only if it is
          yours: Grasp then answers it as you, with what you can see.
        </Trans>
        <ErrorText>{failure}</ErrorText>
      </AlertDescription>
      <AlertAction>
        <div className="flex gap-2">
          <Button
            disabled={busy}
            onClick={() => {
              forgetChatLink();
              void router.invalidate();
            }}
            size="sm"
            variant="ghost"
          >
            <Trans>Not mine</Trans>
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              void link();
            }}
            size="sm"
          >
            <Trans>Link</Trans>
          </Button>
        </div>
      </AlertAction>
    </Alert>
  );
};

/** One linked account, and unlinking it. */
const AccountRow = ({ account }: { account: ChannelAccount }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const app = platformName(account.platform);
  const time = formatDateTime(account.linkedAt);
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
    <div className="flex items-center gap-3 border-t px-5 py-3">
      <MessageSquareIcon
        aria-hidden="true"
        className="text-muted-foreground size-4 flex-none"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          {app} · {shown}
        </span>
        <span className="text-muted-foreground">
          <Trans>Linked {time}</Trans>
        </span>
        <ErrorText>{failure}</ErrorText>
      </div>
      <Button
        aria-label={t`Unlink ${app} account ${shown}`}
        disabled={busy}
        onClick={() => {
          void unlink();
        }}
        size="sm"
        variant="ghost"
      >
        <Trans>Unlink</Trans>
      </Button>
    </div>
  );
};

/** The link waiting for the person, as core read it. */
const PendingLink = ({
  pending,
}: {
  pending: NonNullable<ChatAccounts["pending"]>;
}) => {
  const { preview, secret } = pending;
  if (preview.state === "refused") {
    return <RefusedLink reason={preview.reason} />;
  }
  return (
    <OpenLink
      name={preview.offer.name}
      platform={preview.offer.platform}
      platformUserId={preview.offer.platformUserId}
      secret={secret}
    />
  );
};

/** Settings › Security › Chat apps. */
export const ChatAccountsSection = ({
  chat,
}: {
  chat: Loaded<ChatAccounts>;
}) => {
  const { t } = useLingui();
  const description = t`Chat apps where Grasp knows it’s you. Write to Grasp in one, and it sends you a link to connect your account here. Unlink one you no longer use.`;
  if (chat.state !== "ready") {
    return (
      <SettingsSection description={description} title={t`Chat apps`}>
        <NotLoadedState heading="h3" page={chat} />
      </SettingsSection>
    );
  }
  const { accounts, pending } = chat.data;
  return (
    <SettingsSection description={description} title={t`Chat apps`}>
      {pending === undefined ? null : (
        <SettingsBody>
          <PendingLink pending={pending} />
        </SettingsBody>
      )}
      {accounts.length === 0 ? (
        <SettingsBody>
          <p className="text-muted-foreground">
            <Trans>No chat app accounts are linked.</Trans>
          </p>
        </SettingsBody>
      ) : (
        accounts.map((account) => (
          <AccountRow account={account} key={account.id} />
        ))
      )}
    </SettingsSection>
  );
};
