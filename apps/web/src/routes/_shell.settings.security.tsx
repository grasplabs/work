import type { SignInOption } from "@grasp-os/shared/rpc";
import type { OwnSession, SessionDevice } from "@grasp-os/shared/sign-in";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { CoreConnection } from "../core-connection.ts";
import { deadline, unlessAborted } from "../core.ts";
import { formatDateTime } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIcon, brands } from "../grasp/brand-icon/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Desktop, Phone } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { SettingRow, SettingsRows } from "../grasp/setting-row/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import {
  LinkedChatAccounts,
  PendingChatLink,
} from "../settings/chat-accounts.tsx";
import type { ChatAccounts } from "../settings/chat-accounts.tsx";
import { pendingChatLink } from "../settings/chat-link.ts";
import {
  SectionNotLoaded,
  SettingsError,
  SettingsLoading,
  TitleLine,
} from "../settings/section.tsx";
import { useCore } from "../use-core.ts";

// Settings › Security, as the library's Settings pattern has it (like
// Profile): one compact card that says what the person signs in with, the
// provider's mark and their organization's name; and one with the devices
// they are signed in on, each with its kind's icon, this one marked. Each
// device but this one can be signed out here; this one signs out from the
// person menu. Core names no place a session signed in from.
//
// The chat accounts linked to the person stand as quiet rows in the
// Sign-in card, only when there are any (settings/chat-accounts.tsx). A
// link a chat app sent lands here (routes/chat-link.tsx), so while one
// waits in this tab a card offers to confirm or turn it down; once linked,
// the account stands among the rows. Never for Grasp staff, who aren't the
// company's people. Devices show the newest ten, and all on a press.

const styles = stylex.create({
  // The provider's mark beside the organization's name.
  signedInWith: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
});

/** Whether a sign-in provider has a mark of its own: core's ids are the brands' ("microsoft", "google"). */
const isBrand = (id: string): id is Brand => Object.hasOwn(brands, id);

/** The staff's own way in (core's `providerIds.staff`): not the organization's. */
const staffProvider = "grasp-staff";

/**
 * What the person signed in with: the organization's one way in, with its
 * mark, and the organization's name; for Grasp staff, Grasp's own. With
 * more than one way in, core can't say which they used, so no mark.
 */
const SignedInWith = ({
  options,
  organization,
  staff,
}: {
  options: SignInOption[];
  organization: string | undefined;
  staff: boolean;
}) => {
  const { t } = useLingui();
  const own = options.filter(
    ({ providerId }) => (providerId === staffProvider) === staff
  );
  const [only] = own;
  const provider = own.length === 1 ? only : undefined;
  const name = staff
    ? (provider?.label ?? "Grasp")
    : (organization ?? provider?.label ?? t`Your organization’s account`);
  return (
    <span {...stylex.props(styles.signedInWith)}>
      {provider !== undefined && isBrand(provider.providerId) ? (
        <BrandIcon
          brand={provider.providerId}
          decorative
          size="md"
          tile={false}
        />
      ) : null}
      {name}
    </span>
  );
};

/** What a session signed in on, in the page's language: "Chrome on macOS". */
const useDeviceName = ({ browser, system }: SessionDevice): string => {
  const { t } = useLingui();
  if (browser !== null && system !== null) {
    return t`${browser} on ${system}`;
  }
  return browser ?? system ?? t`Unknown device`;
};

/**
 * The browsers with a mark of their own, by the name core gives them
 * (core's user-agent.ts); any other (Edge, Opera) keeps the device's icon.
 */
const browserMarks: Partial<Record<string, Brand>> = {
  Chrome: "chrome",
  Firefox: "firefox",
  Safari: "safari",
};

const browserMark = (browser: string | null): Brand | undefined =>
  browser === null ? undefined : browserMarks[browser];

/** One device the person is signed in on, and a way to sign it out, after a yes, unless it is this one. */
const DeviceRow = ({ session }: { session: OwnSession }) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const time = formatDateTime(session.signedInAt);
  const device = useDeviceName(session.device);
  const mark = browserMark(session.device.browser);
  const signOut = async (): Promise<void> => {
    // Gone either way once core answers: ended now, or ended already.
    // `sync` waits for the loader, so the row goes with its session.
    await changeThenRefresh(
      async () => {
        await core.withSession(
          async ({ sessions }) => await sessions.end(session.id)
        );
      },
      async () => {
        await router.invalidate({ sync: true });
      }
    );
  };
  return (
    <Item size="xs">
      {mark === undefined ? (
        <ItemMedia
          icon={session.device.mobile ? Phone : Desktop}
          iconLook="inline"
        />
      ) : (
        <ItemMedia>
          <BrandIcon brand={mark} decorative size="md" tile={false} />
        </ItemMedia>
      )}
      <ItemContent>
        <ItemTitle>
          <TitleLine>
            {device}
            {session.current ? <Badge size="sm">{t`This device`}</Badge> : null}
          </TitleLine>
        </ItemTitle>
        <ItemDescription>{t`Signed in ${time}`}</ItemDescription>
      </ItemContent>
      {session.current ? null : (
        <ItemActions>
          <AlertDialog>
            <AlertDialogTrigger
              aria-label={t`Sign out ${device}, signed in ${time}`}
              size="sm"
              variant="ghost"
            >
              {t`Sign out`}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogTitle>{t`Sign out this device?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {t`${device} needs to sign in again to use Grasp.`}
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
                <AlertDialogAction
                  action={signOut}
                  failedLabel={t`Could not sign out`}
                  variant="danger"
                >
                  {t`Sign out`}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </ItemActions>
      )}
    </Item>
  );
};

/** How many devices show before "Show all": the newest. */
const shownAtFirst = 10;

/** The devices the person is signed in on, latest active first, this one marked. */
const Devices = ({ sessions }: { sessions: Loaded<OwnSession[]> }) => {
  const { t } = useLingui();
  const [showAll, setShowAll] = useState(false);
  if (sessions.state !== "ready") {
    return (
      <SectionCard density="compact" title={t`Devices`}>
        <SectionNotLoaded page={sessions} />
      </SectionCard>
    );
  }
  const devices = sessions.data.length;
  const newest = sessions.data.slice(0, shownAtFirst);
  const here = sessions.data.find(({ current }) => current);
  // This device stands in the list whenever it is signed in, however old.
  const shown =
    showAll || devices <= shownAtFirst
      ? sessions.data
      : [
          ...newest,
          ...(here === undefined || newest.includes(here) ? [] : [here]),
        ];
  return (
    <SectionCard
      density="compact"
      description={t`${plural(devices, {
        one: "Signed in on # device. Sign out any you do not recognise.",
        other: "Signed in on # devices. Sign out any you do not recognise.",
      })}`}
      flush
      footer={
        shown.length < devices ? (
          <Button
            onClick={() => {
              setShowAll(true);
            }}
            size="sm"
            variant="ghost"
          >
            {t`Show all ${devices}`}
          </Button>
        ) : undefined
      }
      title={t`Devices`}
    >
      <ItemGroup aria-label={t`Devices`} separated>
        {shown.map((session) => (
          <DeviceRow key={session.id} session={session} />
        ))}
      </ItemGroup>
    </SectionCard>
  );
};

const Security = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const { options, organization, sessions, chat, waiting } =
    Route.useLoaderData();
  return (
    <>
      <SectionCard density="compact" flush title={t`Sign-in`}>
        <SettingsRows>
          <SettingRow
            info={t`Passwords and two-step sign-in live with your organization’s account.`}
            infoLabel={t`More about signing in`}
            label={t`Signed in with`}
          >
            <SignedInWith
              options={options}
              organization={organization}
              staff={identity.staff}
            />
          </SettingRow>
        </SettingsRows>
        {chat?.state === "ready" ? (
          <LinkedChatAccounts accounts={chat.data.accounts} />
        ) : null}
      </SectionCard>
      {chat === undefined || !waiting ? null : <PendingChatLink chat={chat} />}
      <Devices sessions={sessions} />
    </>
  );
};

/** How people sign in here; none when core doesn't say in time. */
const signInOptions = async (
  core: Pick<CoreConnection, "api">
): Promise<SignInOption[]> => {
  try {
    const signal = deadline();
    const api = await core.api(signal);
    return await unlessAborted(Promise.resolve(api.signInOptions()), signal);
  } catch {
    return [];
  }
};

/** The organization's name; none when it has none or core doesn't say in time. */
const organizationName = async (
  core: Pick<CoreConnection, "withSession">
): Promise<string | undefined> => {
  const read = await loadFromCore(
    core,
    async (session) => await session.organization.get()
  );
  const name = read.state === "ready" ? read.data.name.trim() : "";
  return name === "" ? undefined : name;
};

/** The person's linked chat accounts, and the link a chat app sent them while one waits in this tab. */
const chatAccounts = async (
  core: Pick<CoreConnection, "withSession">,
  secret: string | undefined
): Promise<Loaded<ChatAccounts>> =>
  await loadFromCore(core, async (session) => {
    const [accounts, preview] = await Promise.all([
      session.channelAccounts.list(),
      secret === undefined
        ? undefined
        : session.channelAccounts.preview(secret),
    ]);
    return {
      accounts,
      ...(secret === undefined || preview === undefined
        ? {}
        : { pending: { secret, preview } }),
    };
  });

export const Route = createFileRoute("/_shell/settings/security")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Security,
  loader: async ({ context: { core, identity } }) => {
    const secret = pendingChatLink();
    const [options, organization, sessions, chat] = await Promise.all([
      signInOptions(core),
      organizationName(core),
      loadFromCore(core, async (session) => await session.sessions.list()),
      identity.staff ? undefined : chatAccounts(core, secret),
    ]);
    return {
      options,
      organization,
      sessions,
      chat,
      waiting: secret !== undefined,
    };
  },
});
