import type {
  ChannelAccount,
  ChannelLinkPreview,
  ChannelLinkRefusal,
} from "@grasp-os/shared/channel-accounts";
import { chatPlatformName } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { BrandIcon, brands } from "../grasp/brand-icon/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Chat } from "../grasp/icons/index.ts";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
  ItemMedia,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { SettingsRows } from "../grasp/setting-row/index.ts";
import { toast } from "../grasp/toast/index.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { forgetChatLink } from "./chat-link.ts";
import { RowNote, SectionNotLoaded } from "./section.tsx";

// Settings › Security: the person's accounts on chat platforms that are
// linked to them, so Grasp knows it is them writing there, as quiet rows in
// the Sign-in card (none when none are); and a link a chat sent them,
// waiting for them to confirm it, in a card of its own. Confirming is a
// press here, never opening the link (chat apps open links to preview
// them), and the card says whose account it is, by the platform's own
// name for it, so a link someone forwarded doesn't pass for theirs.

/** The linked accounts, and the link waiting in this tab, if any. */
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
    const outcome = { linked: false };
    await run(async ({ channelAccounts }) => {
      await changeThenRefresh(
        async () => {
          const answer = await channelAccounts.link(secret);
          // A refusal keeps the link: the refreshed preview says why.
          if (answer.state === "linked") {
            forgetChatLink();
            outcome.linked = true;
          }
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
    // The card goes and the account stands among the linked ones: say so.
    if (outcome.linked) {
      toast.success(t`Linked`);
    }
  };
  return (
    <Item variant="outline">
      <ItemMedia icon={Chat} />
      <ItemContent>
        <ItemTitle>{t`Link your ${app} account ${account}?`}</ItemTitle>
        <ItemDescription>
          <RowNote failure={failure}>
            {t`Grasp sent this link to that account in ${app}. Link it only if it is yours: Grasp then answers it as you, with what you can see.`}
          </RowNote>
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <>
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
            variant="ink"
          >
            {t`Link`}
          </Button>
        </>
      </ItemActions>
    </Item>
  );
};

/** Whether a Brand icon has this mark. */
const isBrand = (id: string): id is Brand => Object.hasOwn(brands, id);

/** A chat app's mark, where the Brand icons have it; core's platform ids are mostly the brands'. */
const brandOf = (platform: string): Brand | undefined => {
  const id =
    platform === "gchat" || platform === "google-chat" ? "google" : platform;
  return isBrand(id) ? id : undefined;
};

/** One linked account, its chat app's mark, and unlinking it. */
const AccountRow = ({ account }: { account: ChannelAccount }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const app = chatPlatformName(account.platform);
  const shown = account.name ?? account.platformUserId;
  const brand = brandOf(account.platform);
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
      {brand === undefined ? (
        <ItemMedia icon={Chat} iconLook="inline" />
      ) : (
        <ItemMedia>
          <BrandIcon brand={brand} decorative size="md" tile={false} />
        </ItemMedia>
      )}
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

/**
 * The chat accounts linked to the person, one quiet row each, in the
 * Sign-in card under how they sign in; nothing when none are.
 */
export const LinkedChatAccounts = ({
  accounts,
}: {
  accounts: ChannelAccount[];
}) => {
  const { t } = useLingui();
  if (accounts.length === 0) {
    return null;
  }
  return (
    <SettingsRows label={t`Linked chat accounts`}>
      <ItemGroup aria-label={t`Linked chat accounts`} separated>
        {accounts.map((account) => (
          <AccountRow account={account} key={account.id} />
        ))}
      </ItemGroup>
    </SettingsRows>
  );
};

/**
 * A link a chat app sent, waiting in this tab for the person to confirm or
 * turn down; or why the accounts could not be read to show it.
 */
export const PendingChatLink = ({ chat }: { chat: Loaded<ChatAccounts> }) => {
  const { t } = useLingui();
  if (chat.state !== "ready") {
    return (
      <SectionCard density="compact" title={t`Chat apps`}>
        <SectionNotLoaded page={chat} />
      </SectionCard>
    );
  }
  const { pending } = chat.data;
  if (pending === undefined) {
    return null;
  }
  const { preview, secret } = pending;
  return (
    <SectionCard density="compact" title={t`Chat apps`}>
      {preview.state === "refused" ? (
        <RefusedLink reason={preview.reason} />
      ) : (
        <OpenLink
          name={preview.offer.name}
          platform={preview.offer.platform}
          platformUserId={preview.offer.platformUserId}
          secret={secret}
        />
      )}
    </SectionCard>
  );
};
