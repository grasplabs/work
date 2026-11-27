/**
 * An organization's Setup: the company's own Grasp as the admin runs it,
 * from the admin's own records (src/clients/setup.ts), tab by tab, each
 * its own address: how it stands and what needs a look, and what the
 * admin's audit log keeps of it (src/admin/setup-status.tsx), the
 * releases it gets, and its settings. Set on the page as Grasp Work sets
 * one: a group's name over its facts and what staff do about them.
 *
 * What someone at Grasp does to it, where it shows
 * (src/admin/setup-actions.tsx): resume setting it up, pin it, move it to
 * another channel, change how its people sign in, apply its settings,
 * rotate its secrets, set its chat apps up, offboard it. Its account now
 * (reach, drift, shared secrets) is read live once the Status shows, and
 * said only when something is off.
 */
import type { AiStatusReport } from "@grasp-os/shared/ai-status-report";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { CopyButton } from "@grasp-os/ui/components/copy-button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { TabsLink, TabsNav } from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useReducer } from "react";
import type { ReactNode } from "react";

import type { ClientSetup } from "../clients/setup.ts";
import { slackAppManifest, slackRequestUrl } from "../clients/slack-app.ts";
import type { SealedSecretName } from "../deploy/sealed-secrets.ts";
import { ClientHosting } from "../hosting/client-hosting.tsx";
import type { ClientHostingView } from "../hosting/placement.ts";
import type { ProvisioningProgress } from "../hosting/progress.ts";
import type { ProvisioningView } from "../provision/queries.ts";
import { channelWords } from "../rollout/channel-words.ts";
import {
  ApplySettings,
  ChannelChange,
  PinRelease,
  RotateSecrets,
  SealedSecretChange,
  SignInChange,
  StaffWindowChange,
  TeamsBotChange,
  TeamsPackageDownload,
  useRefreshSetup,
} from "./setup-actions.tsx";
import type { Refresh } from "./setup-actions.tsx";
import { Actions, Facts, Group, Quiet } from "./setup-parts.tsx";
import type { Fact } from "./setup-parts.tsx";
import {
  dayOf,
  deployWords,
  History,
  needsOf,
  placedOf,
  releaseOf,
  secretsWaiting,
  Status,
} from "./setup-status.tsx";
import { formatDate } from "./words.ts";

const styles = stylex.create({
  // The tabs, then the tab's parts a step further apart than the lines within each.
  page: { display: "flex", flexDirection: "column", gap: space["8"] },
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
});

/** The section's tabs, in order: how it stands first. */
export const setupTabs = ["status", "history", "releases", "settings"] as const;
export type SetupTab = (typeof setupTabs)[number];

const tabWords: Record<SetupTab, string> = {
  status: "Status",
  history: "History",
  releases: "Releases",
  settings: "Settings",
};

/** Its last deploy, in a few words. */
const deployFact = (deploy: NonNullable<ClientSetup["deploy"]>): string =>
  `${deploy.releaseId}: ${deployWords[deploy.status]}${deploy.error === null ? "" : ` (${deploy.error})`}`;

/** That a change reaches it with its next deploy, while one waits: a fact for a group's facts. */
const liveFact = (setup: ClientSetup): Fact[] =>
  setup.configPending
    ? [{ label: "Live", value: "With the next deploy", attention: true }]
    : [];

// ---- Releases -----------------------------------------------------------

/** Where it gets its releases: its channel and pin, what it runs and should, and changing either. */
const WhereReleases = ({
  clientId,
  setup,
  imported,
  refresh,
}: {
  clientId: string;
  setup: ClientSetup;
  imported: readonly { id: string; notes: string }[];
  refresh: Refresh;
}) => {
  const { provisioning, deploy, target } = setup;
  const { client } = provisioning;
  const runs = releaseOf(setup);
  const pinned = client?.pinnedReleaseId ?? null;
  return (
    <Group
      description="A pinned company stays on its release: promotions skip it."
      id="where"
      title="Where it gets releases"
    >
      <Facts
        rows={[
          {
            label: "Channel",
            value: client === null ? "–" : channelWords[client.channel],
          },
          {
            label: "Release",
            value:
              pinned === null
                ? "Follows its channel"
                : `Pinned to ${pinned}: promotions skip it`,
            attention: pinned !== null,
          },
          { label: "Runs now", value: runs ?? "–" },
          {
            label: "Should run",
            value: target ?? "No release on its channel yet",
            attention: target === null,
          },
          {
            label: "Last deploy",
            value: deploy === null ? "None yet" : deployFact(deploy),
            attention: deploy?.status === "failed",
          },
        ]}
      />
      {client === null ? null : (
        <ChannelChange
          channel={client.channel}
          clientId={clientId}
          refresh={refresh}
        />
      )}
      {/* Only a live company is pinned: one being set up gets the release it was added with. */}
      {client?.status === "active" ? (
        <PinRelease
          clientId={clientId}
          pinned={pinned}
          refresh={refresh}
          releases={imported}
        />
      ) : null}
    </Group>
  );
};

/** The newest releases, each a row to its own page, the one it runs and the one it is pinned to marked. */
const RecentReleases = ({ setup }: { setup: ClientSetup }) => {
  const { releases, provisioning } = setup;
  const runs = releaseOf(setup);
  const pinned = provisioning.client?.pinnedReleaseId ?? null;
  return (
    <Group
      actions={
        <Button asChild size="xs" variant="ghost">
          <Link to="/platform/releases">All releases</Link>
        </Button>
      }
      description={
        setup.moreReleases
          ? `The latest ${releases.length}: older ones are under all releases.`
          : undefined
      }
      id="recent"
      title="Recent releases"
    >
      {releases.length === 0 ? (
        <Quiet>None imported yet.</Quiet>
      ) : (
        <ItemGroup aria-labelledby="recent" separated>
          {releases.map((release) => (
            <Item asChild key={release.id}>
              <Link
                params={{ releaseId: release.id }}
                to="/platform/releases/$releaseId"
              >
                <ItemContent>
                  <ItemTitle>{release.id}</ItemTitle>
                  <ItemDescription>
                    {release.notes === ""
                      ? dayOf(release.builtAt)
                      : `${dayOf(release.builtAt)} · ${release.notes}`}
                  </ItemDescription>
                </ItemContent>
                {release.id === runs || release.id === pinned ? (
                  <ItemActions>
                    {release.id === runs ? (
                      <Badge variant="success">Runs this</Badge>
                    ) : null}
                    {release.id === pinned ? (
                      <Badge variant="outline">Pinned</Badge>
                    ) : null}
                  </ItemActions>
                ) : null}
              </Link>
            </Item>
          ))}
        </ItemGroup>
      )}
    </Group>
  );
};

// ---- Settings -----------------------------------------------------------

/** Who set client's sealed secret `name` and when, as a fact; null while it isn't set. */
const sealedFact = (
  setup: ClientSetup,
  name: SealedSecretName,
  label: string
): Fact | null => {
  const secret = setup.sealedSecrets.find((each) => each.name === name);
  return secret === undefined
    ? null
    : { label, value: `Set on ${dayOf(secret.setAt)} by ${secret.setBy}` };
};

/**
 * A chat app of its own, which most companies never have: what of it is
 * set, and setting it, folded under "Set up" or "Change". What staff
 * typed stays while it is folded, between refreshes.
 */
const ChatApp = ({
  id,
  title,
  none,
  facts,
  children,
}: {
  id: string;
  title: string;
  /** Nothing of it set yet: what the group says instead of its facts. */
  none: string | null;
  facts: readonly Fact[];
  children: ReactNode;
}) => (
  <Collapsible>
    <Group
      actions={
        <CollapsibleTrigger asChild>
          <Button size="xs" variant="outline">
            {none === null ? "Change" : "Set up"}
          </Button>
        </CollapsibleTrigger>
      }
      id={id}
      title={title}
    >
      {none === null ? <Facts rows={facts} /> : <Quiet>{none}</Quiet>}
      <CollapsibleContent asChild>
        <div {...stylex.props(styles.parts)}>{children}</div>
      </CollapsibleContent>
    </Group>
  </Collapsible>
);

/**
 * The client's own Teams bot: its app id, tenant and secret's expiry, and
 * whether its secret is set; setting each, and its app package for its IT.
 */
const TeamsBot = ({
  clientId,
  setup,
  refresh,
}: {
  clientId: string;
  setup: ClientSetup;
  refresh: Refresh;
}) => {
  const bot = setup.teamsBot;
  const secret = sealedFact(setup, "TEAMS_BOT_SECRET", "Secret");
  return (
    <ChatApp
      facts={[
        ...(bot === null
          ? []
          : [
              { label: "App id", value: bot.appId, mono: true },
              { label: "Tenant", value: bot.tenantId, mono: true },
              {
                label: "Secret expires",
                value: formatDate(bot.secretExpiresOn),
              },
            ]),
        secret ?? { label: "Secret", value: "Not set", attention: true },
        ...liveFact(setup),
      ]}
      id="teams"
      none={bot === null && secret === null ? "No bot set." : null}
      title="Its Teams bot"
    >
      {bot === null ? null : <TeamsPackageDownload clientId={clientId} />}
      <TeamsBotChange bot={bot} clientId={clientId} refresh={refresh} />
      <SealedSecretChange
        clientId={clientId}
        description="The bot app's client secret, from its registration in the company's own Entra. It is sealed and never shown again, here or anywhere; its connect gets it with the next deploy."
        label="Client secret"
        name="TEAMS_BOT_SECRET"
        refresh={refresh}
        set={secret !== null}
      />
    </ChatApp>
  );
};

/**
 * The client's own Slack app: whether its bot token and signing secret
 * are set; the manifest to create it from, and setting them.
 */
const SlackApp = ({
  clientId,
  clientName,
  setup,
  refresh,
}: {
  clientId: string;
  clientName: string;
  setup: ClientSetup;
  refresh: Refresh;
}) => {
  const { hostname } = setup.provisioning;
  const token = sealedFact(setup, "SLACK_BOT_TOKEN", "Bot token");
  const signing = sealedFact(setup, "SLACK_SIGNING_SECRET", "Signing secret");
  const set = [token, signing].filter((fact) => fact !== null);
  return (
    <ChatApp
      facts={[...set, ...liveFact(setup)]}
      id="slack"
      none={set.length === 0 ? "No bot token or signing secret set." : null}
      title="Its Slack app"
    >
      {hostname === null ? (
        <Quiet>Give the admin a domain first: the app sends to it.</Quiet>
      ) : (
        <>
          <Facts
            rows={[
              {
                label: "Request URL",
                value: slackRequestUrl(hostname),
                mono: true,
              },
            ]}
          />
          <Actions>
            <CopyButton
              size="sm"
              value={() =>
                JSON.stringify(slackAppManifest(hostname, clientName), null, 2)
              }
              variant="outline"
            >
              Copy app manifest
            </CopyButton>
            <Text as="span" color="muted" size="sm">
              In the company&apos;s Slack, create an app from it, install it,
              then set its bot token and signing secret below.
            </Text>
          </Actions>
        </>
      )}
      <SealedSecretChange
        clientId={clientId}
        description="The app's Bot User OAuth Token (xoxb-), from OAuth & Permissions once it's installed. It is sealed and never shown again; its connect gets it with the next deploy."
        label="Bot token"
        name="SLACK_BOT_TOKEN"
        refresh={refresh}
        set={token !== null}
      />
      <SealedSecretChange
        clientId={clientId}
        description="The app's Signing Secret, from Basic Information. It is sealed and never shown again; its core gets it with the next deploy."
        label="Signing secret"
        name="SLACK_SIGNING_SECRET"
        refresh={refresh}
        set={signing !== null}
      />
    </ChatApp>
  );
};

const Settings = ({
  clientId,
  setup,
  hosting,
  refresh,
}: {
  clientId: string;
  setup: ClientSetup;
  hosting: ClientHostingView | null;
  refresh: Refresh;
}) => {
  const { signIn, account } = setup;
  const { client } = setup.provisioning;
  const waiting = secretsWaiting(account);
  // Where its Grasp is hosted: for a company being set up, or one placed already.
  const hosted =
    hosting !== null &&
    (placedOf(hosting) || client?.status === "provisioning");
  return (
    <div {...stylex.props(styles.parts)}>
      <Group id="sign-in" title="How its people sign in">
        {signIn === null ? (
          <Quiet>Not given yet.</Quiet>
        ) : (
          <Facts
            rows={[
              {
                label: "Last changed",
                value:
                  account?.configChangedAt === null ||
                  account?.configChangedAt === undefined
                    ? "Not since it was set up"
                    : dayOf(account.configChangedAt),
              },
              ...liveFact(setup),
            ]}
          />
        )}
        {client === null ? null : (
          <SignInChange clientId={clientId} refresh={refresh} signIn={signIn} />
        )}
      </Group>
      <Group
        description="While it is open, Grasp's staff can bring in the kickoff and steer the onboarding from here. It reaches the company once its settings are applied, and its own admin can end it."
        id="staff-window"
        title="Grasp's staff window"
      >
        <StaffWindowChange
          canChange={client !== null && signIn !== null}
          clientId={clientId}
          configPending={setup.configPending}
          refresh={refresh}
          setup={setup.staffWindow}
        />
      </Group>
      {client === null ? null : (
        <Group id="apply" title="Applying its settings">
          <ApplySettings
            active={client.status === "active"}
            clientId={clientId}
            configPending={setup.configPending}
            pinned={client.pinnedReleaseId}
            refresh={refresh}
          />
        </Group>
      )}
      <Group
        description="New ones reach it with its next deploy; the old ones keep working a while after."
        id="secrets"
        title="Its secrets"
      >
        {account === null ? (
          <Quiet>Made when it is set up.</Quiet>
        ) : (
          <>
            <Facts
              rows={[
                { label: "Generation", value: String(account.generation) },
                {
                  label: "Last rotated",
                  value:
                    account.rotatedAt === null
                      ? "Never"
                      : dayOf(account.rotatedAt),
                },
                {
                  label: "Live",
                  value: waiting ? "With the next deploy" : "Yes",
                  attention: waiting,
                },
              ]}
            />
            <RotateSecrets clientId={clientId} refresh={refresh} />
          </>
        )}
      </Group>
      {client === null ? null : (
        <>
          <TeamsBot clientId={clientId} refresh={refresh} setup={setup} />
          <SlackApp
            clientId={clientId}
            clientName={client.name}
            refresh={refresh}
            setup={setup}
          />
        </>
      )}
      {hosted ? (
        <Group id="hosting" title="Hosting">
          <ClientHosting view={hosting} />
        </Group>
      ) : null}
    </div>
  );
};

// ---- Following it ---------------------------------------------------------

/** What a Setup holds stays as it was first given. */
const keep = <T,>(held: T): T => held;

/** How often the Setup is read again while something moves on by itself. */
const followMs = 5000;

/**
 * How often a live company's Setup is read again while nothing is known
 * to move: a release promoted to its channel, on Platform or by someone
 * else, shows without the page being loaded again.
 */
const watchMs = 30_000;

/** Phases that move on without the page: its operation works on its own. */
const working: ReadonlySet<ProvisioningView["phase"]> = new Set([
  "provisioning",
]);

/**
 * Whether the reconciler is deploying it, or will at its next tick
 * (src/rollout/reconciler.ts): a deploy is out, or one of its Workers
 * runs another release than it should and that release didn't fail on it
 * (a failed deploy waits for staff).
 */
const deployMoves = ({ provisioning, deploy, target, workers }: ClientSetup) =>
  provisioning.client?.status === "active" &&
  (deploy?.status === "deploying" ||
    (target !== null &&
      workers.some(({ releaseId }) => releaseId !== target) &&
      !(deploy?.status === "failed" && deploy.releaseId === target)));

/**
 * How often the Setup reads itself again, in milliseconds; null when
 * nothing on it changes by itself. Every few seconds while setting the
 * company up moves on (its run, or its operation in a hosting
 * destination) or a deploy is out or due; now and then for any other live
 * company, whose next deploy starts elsewhere.
 */
export const followPaceOf = (
  setup: ClientSetup,
  hosting: ClientHostingView | null
): number | null => {
  const settingUp =
    hosting !== null && placedOf(hosting)
      ? hosting.going
      : working.has(setup.provisioning.phase);
  if (settingUp || deployMoves(setup)) {
    return followMs;
  }
  return setup.provisioning.client?.status === "active" ? watchMs : null;
};

/**
 * Reads the Setup again at its pace (`followPaceOf`) while the page is
 * looked at, and at once when it is looked at again: a tab left open
 * through a rollout shows where it stands on coming back to it.
 */
const useFollow = (
  setup: ClientSetup,
  hosting: ClientHostingView | null,
  refresh: Refresh
) => {
  const pace = followPaceOf(setup, hosting);
  useEffect(() => {
    const read = () => {
      if (pace !== null && document.visibilityState === "visible") {
        void refresh();
      }
    };
    const timer = pace === null ? undefined : setInterval(read, pace);
    document.addEventListener("visibilitychange", read);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [pace, refresh]);
};

/** One tab: a link to the Setup with its search, as each tab has its own address. */
const TabLink = ({
  clientId,
  tab,
  current,
}: {
  clientId: string;
  tab: SetupTab;
  current: boolean;
}) => (
  <TabsLink asChild current={current}>
    <Link
      params={{ clientId }}
      search={tab === "status" ? {} : { tab }}
      to="/organizations/$clientId/setup"
    >
      {tabWords[tab]}
    </Link>
  </TabsLink>
);

/**
 * The company's own Grasp, tab by tab: how it stands, its history, its
 * releases and its settings, from what the admin recorded, so it shows
 * whether or not its core answers.
 */
export const OrgSetup = ({
  clientId,
  setup,
  tab,
  aiStatus,
  progress,
  releases,
  hosting,
}: {
  clientId: string;
  setup: ClientSetup;
  tab: SetupTab;
  /** Its AI as its core reports it, read live and not awaited; null when unknown. */
  aiStatus: Promise<AiStatusReport | null>;
  /** Every imported release, newest first. */
  releases: readonly { id: string; notes: string }[];
  hosting: ClientHostingView | null;
  /** Its setting up, line by line; null when there's no such client. */
  progress: ProvisioningProgress | null;
}) => {
  // Its AI as first read, never replaced: the Setup reads itself again
  // without asking its core again each time (the route's loader).
  const [ai] = useReducer(keep, aiStatus);
  const refresh = useRefreshSetup();
  useFollow(setup, hosting, refresh);
  return (
    <div {...stylex.props(styles.page)}>
      <TabsNav aria-label="Its platform" variant="line">
        {setupTabs.map((each) => (
          <TabLink
            clientId={clientId}
            current={each === tab}
            key={each}
            tab={each}
          />
        ))}
      </TabsNav>
      {tab === "status" ? (
        <Status
          aiStatus={ai}
          clientId={clientId}
          needs={needsOf(setup)}
          progress={progress}
          setup={setup}
        />
      ) : null}
      {tab === "history" ? <History setup={setup} /> : null}
      {tab === "releases" ? (
        <div {...stylex.props(styles.parts)}>
          <WhereReleases
            clientId={clientId}
            imported={releases}
            refresh={refresh}
            setup={setup}
          />
          <RecentReleases setup={setup} />
        </div>
      ) : null}
      {tab === "settings" ? (
        <Settings
          clientId={clientId}
          hosting={hosting}
          refresh={refresh}
          setup={setup}
        />
      ) : null}
    </div>
  );
};
