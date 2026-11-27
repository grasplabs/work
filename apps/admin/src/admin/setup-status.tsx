/**
 * An organization's Setup, its first two tabs: how its own Grasp stands
 * (Status) and what the admin's audit log keeps of it (History), set on
 * the page as Grasp Work sets one: its facts as a list of names and
 * values, the one thing to do (open its Grasp) at the head, its Workers
 * as a table (rows as cards on a phone), its AI in a few facts, and what
 * needs a look as rows with their action. What the admin's records say
 * is worked out here too, for the Releases and Settings tabs
 * (src/admin/setup.tsx) and the follow that reads it again. Unlike the
 * other sections it reads the admin's own records (src/clients/setup.ts),
 * so it shows whether or not the company's core answers.
 */
import type { AiStatusReport } from "@grasp-os/shared/ai-status-report";
import { Badge } from "@grasp-os/ui/components/badge";
import type { BadgeVariant } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import type { KeyValueItem } from "@grasp-os/ui/components/key-value";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import { ArrowUpRightIcon, Icon } from "@grasp-os/ui/lib/icons";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { use, useState, Suspense } from "react";
import type { ReactNode } from "react";

import type { HistoryEntry } from "../clients/queries.ts";
import type { ClientSetup } from "../clients/setup.ts";
import { overBars } from "../clients/watch-signals.ts";
import { retryProvisioningFn } from "../hosting/functions.ts";
import type { ClientHostingView } from "../hosting/placement.ts";
import {
  ProvisioningProgressView,
  ReadySteps,
} from "../hosting/progress-view.tsx";
import type { ProvisioningProgress } from "../hosting/progress.ts";
import {
  notStartedWords,
  operationErrorWords,
  placeRefusals,
} from "../hosting/words.ts";
import type { ProvisioningView } from "../provision/queries.ts";
import { formatTime } from "../releases/format.ts";
import { channelWords } from "../rollout/channel-words.ts";
import type { ClientDriftState } from "../rollout/drift.ts";
import { fetchDrift, retryClientFn } from "../rollout/functions.ts";
import type { DriftCheck } from "../rollout/functions.ts";
import { useRolloutAction } from "../rollout/use-action.ts";
import { thenRefresh, useAction } from "../use-action.ts";
import { aiStatusLine, graspAiLine } from "./ai-status-words.ts";
import { attentionWords } from "./platform-parts.tsx";
import { LiveNumbers } from "./setup-actions.tsx";
import {
  actorWords,
  entryWords,
  errorOf,
  shownEntries,
} from "./setup-history.ts";
import { Actions, ErrorCode, Failure, Group } from "./setup-parts.tsx";
import { formatDate } from "./words.ts";

/** A day as the section says it: "2 Sep 2026". */
export const dayOf = (at: Date): string =>
  formatDate(at.toISOString().slice(0, 10));

/** A version's id, short. */
const shortVersion = (id: string): string => id.slice(0, 8);

// The words of the admin's own records, as staff read them.

type DeployStatus = NonNullable<ClientSetup["deploy"]>["status"];

export const deployWords: Record<DeployStatus, string> = {
  deploying: "deploying",
  done: "done",
  failed: "failed",
};

const driftWords: Record<ClientDriftState, string> = {
  in_sync: "In sync: it runs what the admin made live",
  drifted: "Runs another version than the admin made live",
  split: "Runs two versions at once",
  off_pin: "Runs another release than it is pinned to",
  unknown: "Not known: nothing is live yet, or its account didn’t answer",
};

// What the admin's records say, worked out.

/** What about a company's platform needs someone at Grasp, the most pressing first. */
type PlatformNeed =
  | {
      kind: "attention";
      attention: NonNullable<ProvisioningView["needsAttention"]>;
      view: ProvisioningView;
    }
  | { kind: "provisioning"; view: ProvisioningView }
  | { kind: "not_started"; why: ProvisioningView["notStarted"] }
  | { kind: "deploy"; deploy: NonNullable<ClientSetup["deploy"]> }
  | { kind: "secrets" }
  | { kind: "settings" }
  | { kind: "teams_bot_secret"; days: number }
  | { kind: "stephen"; over: number };

/** How many days before its Teams bot's secret expires its Setup says it needs a new one. */
const botSecretWarnDays = 30;

/** How long until its Teams bot's secret expires, `days` from now, as a sentence. */
const botSecretWords = (days: number): string => {
  if (days > 1) {
    return `Its Teams bot's secret expires in ${days} days.`;
  }
  if (days === 1) {
    return "Its Teams bot's secret expires tomorrow.";
  }
  return days === 0
    ? "Its Teams bot's secret expires today: Stephen stops answering in Teams once it has."
    : "Its Teams bot's secret has expired: Stephen can't answer in Teams.";
};

/** What a live company's chat apps need: a new bot secret soon, a look at Stephen. */
const chatNeedsOf = (setup: ClientSetup): PlatformNeed[] => {
  const needs: PlatformNeed[] = [];
  const days = setup.teamsBotSecretDays;
  if (days !== null && days <= botSecretWarnDays) {
    needs.push({ kind: "teams_bot_secret", days });
  }
  const over =
    setup.watched === null ? 0 : overBars(setup.watched.signals).size;
  if (over > 0) {
    needs.push({ kind: "stephen", over });
  }
  return needs;
};

/** Whether its secrets rotated and no deploy has made them live since. */
export const secretsWaiting = (account: ClientSetup["account"]): boolean =>
  account?.rotatedAt !== null &&
  account?.rotatedAt !== undefined &&
  (account.rotationLiveAt === null ||
    account.rotationLiveAt < account.rotatedAt);

export const needsOf = (setup: ClientSetup): PlatformNeed[] => {
  const { provisioning, deploy, target } = setup;
  const needs: PlatformNeed[] = [];
  if (provisioning.phase === "failed") {
    needs.push(
      provisioning.needsAttention === null
        ? { kind: "provisioning", view: provisioning }
        : {
            kind: "attention",
            attention: provisioning.needsAttention,
            view: provisioning,
          }
    );
  }
  if (provisioning.phase === "placing") {
    needs.push({ kind: "not_started", why: provisioning.notStarted });
  }
  // Failed on its target: the reconciler leaves it until staff retry.
  if (deploy?.status === "failed" && deploy.releaseId === target) {
    needs.push({ kind: "deploy", deploy });
  }
  const active = provisioning.client?.status === "active";
  if (active && secretsWaiting(setup.account)) {
    needs.push({ kind: "secrets" });
  }
  if (active && setup.configPending) {
    needs.push({ kind: "settings" });
  }
  return active ? [...needs, ...chatNeedsOf(setup)] : needs;
};

/** A need in a sentence. */
const needWords = (need: PlatformNeed): ReactNode => {
  if (need.kind === "attention") {
    const { attention, view } = need;
    const code = attention.code ?? view.stopped?.error ?? null;
    return (
      <>
        {attentionWords[attention.reason]}
        {code === null ? null : (
          <>
            {" "}
            <ErrorCode code={code} />
            {` ${operationErrorWords(code)}`}
          </>
        )}
      </>
    );
  }
  if (need.kind === "provisioning") {
    const { view } = need;
    return view.stopped === null ? (
      "Stopped: Grasp is retrying it by itself."
    ) : (
      <>
        {`Stopped after its ${view.stopped.step} step; Grasp is retrying it by itself: `}
        <ErrorCode code={view.stopped.error} />
        {` ${operationErrorWords(view.stopped.error)}`}
      </>
    );
  }
  if (need.kind === "not_started") {
    return notStartedWords(need.why);
  }
  if (need.kind === "deploy") {
    const { deploy } = need;
    const what = `Its deploy of ${deploy.releaseId} failed`;
    return deploy.error === null ? (
      `${what}: retry it once what stopped it is fixed.`
    ) : (
      <>
        {`${what}: `}
        <ErrorCode code={deploy.error} />
        {` ${operationErrorWords(deploy.error)} Retry it once what stopped it is fixed.`}
      </>
    );
  }
  if (need.kind === "secrets") {
    return "New secrets wait to reach it: the next deploy carries them.";
  }
  if (need.kind === "settings") {
    return "Changed settings wait to reach it: the next deploy carries them.";
  }
  if (need.kind === "teams_bot_secret") {
    return `${botSecretWords(need.days)} Mint a new client secret for its bot in its own Entra and set it under Its Teams bot, with the day it expires.`;
  }
  return `${need.over === 1 ? "One of Stephen's signals is" : `${need.over} of Stephen's signals are`} over its bar: see Stephen below.`;
};

/** How a company's platform stands, as one word. */
type Standing = "setup" | "healthy" | "attention" | "offboarded";

const standingOf = (setup: ClientSetup, needs: PlatformNeed[]): Standing => {
  if (setup.provisioning.client?.status === "offboarded") {
    return "offboarded";
  }
  if (needs.length > 0) {
    return "attention";
  }
  return setup.provisioning.client?.status === "active" ? "healthy" : "setup";
};

const standingWords: Record<Standing, string> = {
  setup: "Being set up",
  healthy: "Healthy",
  attention: "Needs a look",
  offboarded: "Offboarded",
};

/** The release its core runs: the one its people meet. */
export const releaseOf = (setup: ClientSetup): string | null =>
  setup.workers.find(({ worker }) => worker === "core")?.releaseId ?? null;

/**
 * Retry now: resumes its provisioning as the staff member
 * (`retryProvisioningFn`), which starts a new episode of automatic
 * retries and clears what needed attention.
 */
const RetryNow = ({ clientId }: { clientId: string }) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(placeRefusals);
  const retry = () => {
    void run(
      async () =>
        await thenRefresh(
          async () => await retryProvisioningFn({ data: { clientId } }),
          async () => {
            await router.invalidate({ sync: true });
          }
        )
    );
  };
  return (
    <Actions>
      <Button disabled={busy} onClick={retry} size="sm" variant="outline">
        Retry now
      </Button>
      <Failure failure={failure} />
    </Actions>
  );
};

/**
 * Retry its deploy: clears its failed deploy as the staff member
 * (`retryClientFn`), so the reconciler deploys it again, pinned or not.
 */
const RetryDeploy = ({ clientId }: { clientId: string }) => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  const retry = () => {
    void run(
      async () =>
        await thenRefresh(
          async () => await retryClientFn({ data: { clientId } }),
          async () => {
            await router.invalidate({ sync: true });
          }
        )
    );
  };
  return (
    <Actions>
      <Button disabled={busy} onClick={retry} size="sm" variant="outline">
        Retry
      </Button>
      <Failure failure={failure} />
    </Actions>
  );
};

/** Where what a need says is seen to: Platform, or the tab it is done on. */
const NeedAction = ({
  clientId,
  need,
}: {
  clientId: string;
  need: PlatformNeed;
}) => {
  switch (need.kind) {
    case "deploy": {
      return <RetryDeploy clientId={clientId} />;
    }
    case "secrets":
    case "settings":
    case "teams_bot_secret": {
      return (
        <Button asChild size="sm" variant="outline">
          <Link
            params={{ clientId }}
            search={{ tab: "settings" }}
            to="/organizations/$clientId/setup"
          >
            Its settings
          </Link>
        </Button>
      );
    }
    case "attention": {
      return <RetryNow clientId={clientId} />;
    }
    case "provisioning":
    case "not_started":
    case "stephen": {
      // Setting it up, and Stephen's signals, are seen to below, on this tab.
      return null;
    }
    default: {
      return need satisfies never;
    }
  }
};

/**
 * What staff do about its operation once it stopped, beside why: Retry its
 * failed deploy, or resume its setting up; nothing while neither is
 * theirs to do (a deploy the reconciler starts again by itself).
 */
const StoppedAction = ({
  clientId,
  needs,
  setup,
}: {
  clientId: string;
  needs: PlatformNeed[];
  setup: ClientSetup;
}) => {
  if (needs.some(({ kind }) => kind === "deploy")) {
    return <RetryDeploy clientId={clientId} />;
  }
  return setup.provisioning.client?.status === "provisioning" ? (
    <RetryNow clientId={clientId} />
  ) : null;
};

/** How long a company's progress stays on its Setup once it is ready. */
const readyShownMs = 24 * 60 * 60 * 1000;

/** Whether its setting up shows: while it goes or waits, and for a day once ready. */
const showsProgress = (progress: ProvisioningProgress): boolean =>
  progress.readyAt === null ||
  Date.now() - progress.readyAt.getTime() < readyShownMs;

/** Whether a company is in a hosting destination, or being provisioned in one. */
export const placedOf = (hosting: ClientHostingView | null): boolean =>
  hosting !== null &&
  (hosting.placement !== null || hosting.operation !== null);

/** Milliseconds as seconds, to one decimal. */
const secondsOf = (ms: number | null): string =>
  ms === null ? "No answers to time" : `up to ${(ms / 1000).toFixed(1)} s`;

/** Whether it runs the shared secrets in Secrets Store now, in words. */
const sharedSecretsWords = (current: boolean | null): string => {
  if (current === null) {
    return "Whether it runs the shared secrets in Secrets Store now can’t be told: the store or its account couldn’t be read, or nothing is live on it yet.";
  }
  return current
    ? "It runs the shared secrets in Secrets Store now."
    : "It doesn’t run the shared secrets in Secrets Store now: its next deploy, which the reconciler starts by itself, brings it up to date.";
};

/** What its account's live read depends on: the versions the admin made live, and its last deploy's standing. */
const liveKeyOf = (setup: ClientSetup): string =>
  [
    ...setup.workers.map(({ worker, versionId }) => `${worker}:${versionId}`),
    setup.deploy?.status ?? "none",
  ].join(" ");
// ---- The page's parts -----------------------------------------------------

const STACKED = "@media (width < 48rem)";
const WIDE = "@media (width >= 64rem)";

const styles = stylex.create({
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
  // Its facts beside its AI once there is room for both.
  facts: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [WIDE]: "minmax(0, 3fr) minmax(0, 2fr)",
    },
    columnGap: space["12"],
    rowGap: space["10"],
    alignItems: "start",
  },
  table: { display: { default: "block", [STACKED]: "none" } },
  cards: { display: { default: "none", [STACKED]: "block" } },
  mono: {
    fontFamily: font.mono,
    fontSize: font.textSm,
    fontVariantNumeric: "tabular-nums",
  },
  quiet: { color: colors.mutedForeground },
  // A limit reached: its mark, then what that means, wrapping under it.
  reached: {
    display: "inline-flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: space["2"],
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
});

const standingTones: Readonly<Record<Standing, BadgeVariant>> = {
  setup: "default",
  healthy: "success",
  attention: "warning",
  offboarded: "default",
};

/** Its last deploy, in a few words: its release, how it ended, and when it started. */
const lastDeployWords = (deploy: ClientSetup["deploy"]): ReactNode => {
  if (deploy === null) {
    return "None yet";
  }
  const how = `${deploy.releaseId} · ${deployWords[deploy.status]} · ${dayOf(deploy.startedAt)}`;
  return deploy.status === "failed" ? (
    <Badge variant="destructive">{how}</Badge>
  ) : (
    how
  );
};

/** Whether it is set up, in a few words: done (when), going (its steps below), or not started. */
const setUpFact = (
  client: ProvisioningView["client"],
  progress: ProvisioningProgress | null
): KeyValueItem => {
  if (progress?.state === "ready" && progress.readyAt !== null) {
    return {
      id: "setup",
      label: "Set up",
      value: `Every step done, ${dayOf(progress.readyAt)}`,
    };
  }
  let value = "Every step done";
  if (progress !== null) {
    value = "Going: its steps are below";
  } else if (client === null || client.status === "provisioning") {
    value = "Not started";
  }
  return { id: "setup", label: "Set up", value };
};

/** Its address, health, release and channel, last deploy and setting up, as facts. */
const statusFacts = (
  clientId: string,
  setup: ClientSetup,
  needs: PlatformNeed[],
  progress: ProvisioningProgress | null
): KeyValueItem[] => {
  const { provisioning, deploy } = setup;
  const { client } = provisioning;
  const standing = standingOf(setup, needs);
  const runs = releaseOf(setup);
  const pinned = client?.pinnedReleaseId ?? null;
  let release = runs ?? "Nothing live yet";
  if (client !== null) {
    release =
      runs === null
        ? `Nothing live yet, on ${channelWords[client.channel]}`
        : `${runs} on ${channelWords[client.channel]}${pinned === null ? "" : ", pinned"}`;
  }
  return [
    {
      id: "health",
      label: "Health",
      value: (
        <Badge dot variant={standingTones[standing]}>
          {standingWords[standing]}
        </Badge>
      ),
    },
    {
      id: "address",
      label: "Address",
      value: provisioning.hostname ?? clientId,
      mono: true,
      copyable: provisioning.hostname ?? undefined,
    },
    { id: "release", label: "Release", value: release },
    { id: "deploy", label: "Last deploy", value: lastDeployWords(deploy) },
    setUpFact(client, progress),
  ];
};

/** Its AI as facts, once its core reported it: its own provider, and Grasp's AI against its limit. */
const AiFacts = ({ status }: { status: Promise<AiStatusReport | null> }) => {
  const report = use(status);
  const grasp = graspAiLine(report);
  const items: KeyValueItem[] = [
    { id: "provider", label: "Its own provider", value: aiStatusLine(report) },
  ];
  if (grasp !== null) {
    items.push({
      id: "grasp",
      label: "Grasp’s AI this month",
      value:
        report?.graspAi?.reached === true ? (
          <span {...stylex.props(styles.reached)}>
            <Badge variant="destructive">Limit reached</Badge>
            {grasp}
          </span>
        ) : (
          grasp
        ),
    });
  }
  return <KeyValueList divided items={items} orientation="horizontal" />;
};

/**
 * Its AI, read only, as its core reports it from real calls: which
 * provider its organization connected and whether it answers, and Grasp's
 * own AI against its limit. Its admins connect a provider in their own
 * Settings.
 */
const AiPart = ({ status }: { status: Promise<AiStatusReport | null> }) => (
  <Group
    description="Its admins connect a provider in their own Settings."
    id="ai"
    title="AI"
  >
    <Suspense
      fallback={
        <KeyValueList
          divided
          items={[
            {
              id: "provider",
              label: "Its own provider",
              value: "",
              loading: true,
            },
            {
              id: "grasp",
              label: "Grasp’s AI this month",
              value: "",
              loading: true,
            },
          ]}
          orientation="horizontal"
        />
      }
    >
      <AiFacts status={status} />
    </Suspense>
  </Group>
);

/** What needs someone at Grasp, each a row with what to do about it. */
const NeedsPart = ({
  clientId,
  needs,
}: {
  clientId: string;
  needs: PlatformNeed[];
}) =>
  needs.length === 0 ? null : (
    <Group id="needs" title="What needs a look">
      <ItemGroup aria-labelledby="needs" separated>
        {needs.map((need) => (
          <Item key={need.kind}>
            <ItemContent>
              <ItemTitle>{needWords(need)}</ItemTitle>
            </ItemContent>
            <ItemActions>
              <NeedAction clientId={clientId} need={need} />
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </Group>
  );

/**
 * How its Stephen fares in the chat apps, as the admin's watch last read
 * it (src/clients/watch.ts): a fact a signal, the ones over their bar
 * marked, as staff were told of them.
 */
const StephenPart = ({ setup }: { setup: ClientSetup }) => {
  const { watched } = setup;
  if (watched === null) {
    return null;
  }
  const { signals, readAt } = watched;
  const over = overBars(signals);
  const marked = (value: string, signal: Parameters<typeof over.has>[0]) =>
    over.has(signal) ? <Badge variant="warning">{value}</Badge> : value;
  return (
    <Group
      description={`Over the last ${signals.hours} hours, as the admin's hourly watch read it at ${formatTime(readAt)}.`}
      id="stephen"
      title="Stephen"
    >
      <KeyValueList
        divided
        items={[
          {
            id: "answered",
            label: "Answered",
            value: String(signals.answered),
          },
          {
            id: "time",
            label: "Answer time",
            value: marked(
              `Median ${secondsOf(signals.p50Ms)}, 9 in 10 ${secondsOf(signals.p90Ms)}`,
              "stephen_slow"
            ),
          },
          {
            id: "failed",
            label: "Turns failed",
            value: marked(String(signals.failed), "stephen_failing"),
          },
          {
            id: "busy",
            label: "Busy",
            value: marked(String(signals.busy), "stephen_busy"),
          },
          {
            id: "refused",
            label: "Requests refused",
            value: marked(String(signals.refused), "stephen_refused"),
          },
          {
            id: "sends",
            label: "Sends failed",
            value: marked(String(signals.sendFailed), "stephen_sends_failing"),
          },
          {
            id: "uninstalled",
            label: "Uninstalled",
            value: marked(String(signals.uninstalled), "stephen_uninstalled"),
          },
          {
            id: "again",
            label: "Need a new sign-in",
            value: marked(
              `${signals.companyAgain} of the company's connections, ${signals.personalAgain} of people's own`,
              "stephen_connections_again"
            ),
          },
        ]}
        orientation="horizontal"
      />
    </Group>
  );
};

/** What runs in its account, read from Cloudflare when staff ask. */
const WhatRuns = ({ clientId }: { clientId: string }) => {
  const [drift, setDrift] = useState<DriftCheck | null | "failed">(null);
  const [reading, setReading] = useState(false);
  const read = async () => {
    setReading(true);
    try {
      setDrift(await fetchDrift({ data: { clientId } }));
    } catch {
      setDrift("failed");
    }
    setReading(false);
  };
  let said: ReactNode = "What Cloudflare says runs, read when you ask.";
  if (drift === "failed") {
    said = "Its account couldn’t be read. Try again in a while.";
  } else if (drift !== null) {
    said =
      drift.state === "in_sync" || drift.state === "unknown" ? (
        driftWords[drift.state]
      ) : (
        <Badge variant="warning">{driftWords[drift.state]}</Badge>
      );
  }
  return (
    <>
      <div {...stylex.props(styles.row)}>
        <Text as="span" color="muted" size="sm">
          {said}
        </Text>
        <Button
          disabled={reading}
          onClick={() => {
            void read();
          }}
          size="sm"
          variant="outline"
        >
          {drift === null ? "Read what runs" : "Read again"}
        </Button>
      </div>
      {drift !== null && drift !== "failed" ? (
        <>
          <Text color="muted" size="sm">
            {sharedSecretsWords(drift.sharedSecretsCurrent)}
          </Text>
          <Table aria-label="What Cloudflare says runs">
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Made live</TableHead>
                <TableHead>Running</TableHead>
                <TableHead hideBelow="md">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drift.workers.map((worker) => (
                <TableRow key={worker.worker}>
                  <TableCell rowHeader>{worker.scriptName}</TableCell>
                  <TableCell>
                    <span {...stylex.props(styles.mono)}>
                      {worker.recorded === null
                        ? "–"
                        : shortVersion(worker.recorded)}
                    </span>
                  </TableCell>
                  <TableCell wrap>
                    <span {...stylex.props(styles.mono)}>
                      {worker.live === null
                        ? "not known"
                        : worker.live
                            .map(
                              ({ version_id: version, percentage }) =>
                                `${shortVersion(version)} at ${percentage}%`
                            )
                            .join(", ")}
                    </span>
                  </TableCell>
                  <TableCell hideBelow="md" wrap>
                    {driftWords[worker.state]}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      ) : null}
    </>
  );
};

/** A Worker's name as the section says it: "Core". */
const workerName = (worker: string): string =>
  `${worker.slice(0, 1).toUpperCase()}${worker.slice(1)}`;

/**
 * What runs in its account: each Worker as the admin made it live (a
 * table, a card a Worker on a phone), what Cloudflare says runs when staff
 * ask, and what its deploys keep there. Nothing before anything is live.
 */
const WorkersPart = ({
  clientId,
  setup,
}: {
  clientId: string;
  setup: ClientSetup;
}) => {
  const { workers, resources } = setup;
  if (workers.length === 0) {
    return null;
  }
  const kept: KeyValueItem[] =
    resources === null
      ? []
      : [
          ...resources.databases.map((name) => ({
            id: `db-${name}`,
            label: "Database",
            value: name,
            mono: true,
          })),
          ...resources.buckets.map((name) => ({
            id: `files-${name}`,
            label: "Files",
            value: name,
            mono: true,
          })),
        ];
  return (
    <>
      <Group id="workers" title="Workers">
        <div {...stylex.props(styles.table)}>
          <Table aria-label="Workers">
            <TableHeader>
              <TableRow>
                <TableHead>Worker</TableHead>
                <TableHead>Release</TableHead>
                <TableHead>Version</TableHead>
                <TableHead align="end">Made live</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workers.map((worker) => (
                <TableRow key={worker.worker}>
                  <TableCell rowHeader>
                    {workerName(worker.worker)}{" "}
                    <span {...stylex.props(styles.quiet)}>
                      {worker.scriptName}
                    </span>
                  </TableCell>
                  <TableCell>{worker.releaseId ?? "–"}</TableCell>
                  <TableCell>
                    <span {...stylex.props(styles.mono)}>
                      {worker.versionId === null
                        ? "–"
                        : shortVersion(worker.versionId)}
                    </span>
                  </TableCell>
                  <TableCell align="end">
                    {worker.deployedAt === null
                      ? "–"
                      : dayOf(worker.deployedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div {...stylex.props(styles.cards)}>
          <ItemGroup aria-labelledby="workers" separated>
            {workers.map((worker) => (
              <Item key={worker.worker}>
                <ItemContent>
                  <ItemTitle>{workerName(worker.worker)}</ItemTitle>
                  <ItemDescription>
                    {[
                      worker.releaseId ?? "Nothing live",
                      worker.versionId === null
                        ? null
                        : shortVersion(worker.versionId),
                      worker.deployedAt === null
                        ? null
                        : `made live ${dayOf(worker.deployedAt)}`,
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </div>
        <WhatRuns clientId={clientId} />
      </Group>
      {kept.length === 0 ? null : (
        <Group
          description="What the release it runs keeps in its account."
          id="kept"
          title="What it keeps"
        >
          <KeyValueList divided items={kept} orientation="horizontal" />
        </Group>
      )}
    </>
  );
};

/** The way into its own Grasp, and to its audit trail there, in new tabs: the page's one primary action. */
const IntoItsGrasp = ({ hostname }: { hostname: string }) => (
  <>
    <Button asChild size="sm" variant="ghost">
      <a
        aria-label="Its activity, in a new tab"
        href={`https://${hostname}/settings/audit`}
        rel="noopener noreferrer"
        target="_blank"
      >
        Its activity
      </a>
    </Button>
    <Button asChild size="sm">
      <a
        aria-label="Open its Grasp, in a new tab"
        href={`https://${hostname}`}
        rel="noopener noreferrer"
        target="_blank"
      >
        Open its Grasp
        <Icon icon={ArrowUpRightIcon} />
      </a>
    </Button>
  </>
);

/**
 * How its own Grasp stands: the way into it at the head, its facts beside
 * its AI, what needs a look, its setting up while that goes, its account
 * when something there is off, Stephen, and its Workers.
 */
export const Status = ({
  clientId,
  setup,
  needs,
  aiStatus,
  progress,
}: {
  clientId: string;
  setup: ClientSetup;
  needs: PlatformNeed[];
  /** Its AI as its core reports it, read live and not awaited; null when unknown. */
  aiStatus: Promise<AiStatusReport | null>;
  progress: ProvisioningProgress | null;
}) => {
  const { provisioning } = setup;
  const active = provisioning.client?.status === "active";
  const { hostname } = provisioning;
  const shown = progress !== null && showsProgress(progress);
  const going = shown && progress.state !== "ready";
  return (
    <div {...stylex.props(styles.parts)}>
      <div {...stylex.props(active && styles.facts)}>
        <Group
          actions={
            hostname === null || !active ? null : (
              <IntoItsGrasp hostname={hostname} />
            )
          }
          id="stands"
          title="How it stands"
        >
          <KeyValueList
            divided
            items={statusFacts(clientId, setup, needs, progress)}
            orientation="horizontal"
          />
          {/* For a day once every step is done, its steps and who is invited, folded. */}
          {shown && !going ? (
            <Collapsible fitContent>
              <CollapsibleTrigger>Its steps</CollapsibleTrigger>
              <CollapsibleContent asChild>
                <div>
                  <ReadySteps progress={progress} />
                </div>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </Group>
        {active ? <AiPart status={aiStatus} /> : null}
      </div>
      <NeedsPart clientId={clientId} needs={needs} />
      {going ? (
        <ProvisioningProgressView progress={progress}>
          <StoppedAction clientId={clientId} needs={needs} setup={setup} />
        </ProvisioningProgressView>
      ) : null}
      {active ? (
        // Read again once what it runs changed: a deploy that ended.
        <LiveNumbers clientId={clientId} key={liveKeyOf(setup)} />
      ) : null}
      <StephenPart setup={setup} />
      <WorkersPart clientId={clientId} setup={setup} />
    </div>
  );
};

// ---- History ----------------------------------------------------------------

/** What an entry happened in, and its error's code when it records one. */
const EntryWhat = ({ entry }: { entry: HistoryEntry }) => {
  const error = errorOf(entry.detail);
  return (
    <>
      {entryWords(entry)}
      {error === null ? null : (
        <>
          {" "}
          <ErrorCode code={error} />
        </>
      )}
    </>
  );
};

/**
 * Everything the admin's audit log keeps of it, the newest first: a table
 * of when, what and who, and on a phone a row each with who and when under
 * what happened.
 */
export const History = ({ setup }: { setup: ClientSetup }) => {
  const entries = shownEntries(setup.history);
  if (entries.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyDescription>Nothing is in its history yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Group
      description="The newest first. Times in UTC."
      id="history"
      title="Its history"
    >
      <div {...stylex.props(styles.table)}>
        <Table aria-label="Its history">
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Who</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>{formatTime(entry.at)}</TableCell>
                <TableCell rowHeader wrap>
                  <EntryWhat entry={entry} />
                </TableCell>
                <TableCell>{actorWords(entry.actor)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div {...stylex.props(styles.cards)}>
        <ItemGroup aria-labelledby="history" separated>
          {entries.map((entry) => (
            <Item key={entry.id} size="sm">
              <ItemContent>
                <ItemTitle>
                  <EntryWhat entry={entry} />
                </ItemTitle>
                <ItemDescription>
                  {`${actorWords(entry.actor)} · ${formatTime(entry.at)}`}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </div>
    </Group>
  );
};
