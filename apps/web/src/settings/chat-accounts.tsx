import type {
  ChannelAccount,
  ChannelLinkPreview,
  ChannelLinkRefusal,
  ChannelReach,
} from "@grasp-os/shared/channel-accounts";
import { chatPlatformName } from "@grasp-os/shared/chat";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { formatDateTime } from "../format.ts";
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
import { Separator } from "../grasp/separator/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { forgetChatLink } from "./chat-link.ts";
import { RowNote, SectionNotLoaded, TitleLine } from "./section.tsx";
import { WhereStephen } from "./where-stephen.tsx";

// Settings › Security › Chat apps: the person's accounts on chat platforms
// that are linked to them, so Grasp knows it is them writing there, and a
// link a chat sent them, waiting for them to confirm it. Confirming is a
// press here, never opening the link (chat apps open links to preview
// them), and the card says whose account it is, by the platform's own
// name for it, so a link someone forwarded doesn't pass for theirs.

const styles = stylex.create({
  // In the rows' inline padding, so the card's parts share a left edge.
  pad: { paddingBlock: grasp.space3, paddingInline: grasp.tableCellInline },
});

/**
 * What the section shows: where to reach Stephen, the linked accounts,
 * and the link waiting, if any.
 */
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

/** One linked account, and unlinking it. */
const AccountRow = ({ account }: { account: ChannelAccount }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const app = chatPlatformName(account.platform);
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
    <Item size="sm">
      <ItemContent>
        <ItemTitle>
          <TitleLine
            detail={<RowNote failure={failure}>{t`Linked ${time}`}</RowNote>}
          >
            {t`${app} · ${shown}`}
          </TitleLine>
        </ItemTitle>
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
  const description = t`Where Grasp knows it’s you. Write to Grasp in one to link it here.`;
  if (chat.state !== "ready") {
    return (
      <SectionCard description={description} title={t`Chat apps`}>
        <SectionNotLoaded page={chat} />
      </SectionCard>
    );
  }
  const { reach, accounts, pending } = chat.data;
  return (
    <SectionCard description={description} flush title={t`Chat apps`}>
      {pending === undefined ? null : (
        <div {...stylex.props(styles.pad)}>
          <PendingLink pending={pending} />
        </div>
      )}
      <WhereStephen reach={reach} />
      {reach.length === 0 ? null : <Separator decorative />}
      {accounts.length === 0 ? (
        <div {...stylex.props(styles.pad)}>
          <Text size="sm" tone="muted">
            {t`No chat app accounts are linked.`}
          </Text>
        </div>
      ) : (
        <ItemGroup aria-label={t`Linked accounts`} separated>
          {accounts.map((account) => (
            <AccountRow account={account} key={account.id} />
          ))}
        </ItemGroup>
      )}
    </SectionCard>
  );
};
