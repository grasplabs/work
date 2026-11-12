/**
 * An organization's Setup: the company's own Grasp as the admin runs
 * it, ported from the prototype (grasplabs/prototype
 * `components/admin/org-setup.tsx`, `platform-parts.tsx` and
 * `platform-words.ts`). Unlike the other sections it reads the admin's
 * own records (src/clients/setup.ts): how it stands and what needs a
 * look, its setting up step by step, what runs in its account, what the
 * admin's audit log keeps of it, the releases it gets, and how its
 * people sign in.
 *
 * And what someone at Grasp does to it, where it shows
 * (src/admin/setup-actions.tsx): resume setting it up, pin it, move it to
 * another channel, change how its people sign in, apply its settings,
 * rotate its secrets, offboard it. Its account now (reach, drift, shared
 * secrets) is read live once the section shows, and said only when
 * something is off.
 */
import type { AiStatusReport } from "@grasp-os/shared/ai-status-report";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { cn } from "@grasp-os/ui/lib/utils";
import { Await, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import type { HistoryEntry } from "../clients/queries.ts";
import type { ClientSetup } from "../clients/setup.ts";
import { slackAppManifest, slackRequestUrl } from "../clients/slack-app.ts";
import { overBars } from "../clients/watch-signals.ts";
import { channelIds } from "../db/schema.ts";
import type { SealedSecretName } from "../deploy/sealed-secrets.ts";
import { ClientHosting } from "../hosting/client-hosting.tsx";
import { retryProvisioningFn } from "../hosting/functions.ts";
import type { ClientHostingView } from "../hosting/placement.ts";
import { ProvisioningProgressView } from "../hosting/progress-view.tsx";
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
import { Section } from "./section.tsx";
import {
  ApplySettings,
  LiveNumbers,
  PinRelease,
  ChannelChange,
  RotateSecrets,
  SignInChange,
  StaffWindowChange,
  SealedSecretChange,
  TeamsBotChange,
  TeamsPackageDownload,
  useRefreshSetup,
} from "./setup-actions.tsx";
import type { Refresh } from "./setup-actions.tsx";
import { ErrorCode, Facts, Quiet } from "./setup-parts.tsx";
import { formatDate } from "./words.ts";

/** The section's tabs, in order: how it stands first. */
export const setupTabs = ["status", "history", "releases", "settings"] as const;
export type SetupTab = (typeof setupTabs)[number];

const tabWords: Record<SetupTab, string> = {
  status: "Status",
  history: "History",
  releases: "Releases",
  settings: "Settings",
};

/** A day as the section says it: "2 Sep 2026". */
const dayOf = (at: Date): string => formatDate(at.toISOString().slice(0, 10));

/** A version's id, short. */
const shortVersion = (id: string): string => id.slice(0, 8);

// The words of the admin's own records, as staff read them.

type DeployStatus = NonNullable<ClientSetup["deploy"]>["status"];

const deployWords: Record<DeployStatus, string> = {
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

// The section's parts.

/** The way to another of the Setup's tabs, where what it says is seen to. */
const TabLink = ({
  clientId,
  tab,
  children,
}: {
  clientId: string;
  tab: SetupTab;
  children: ReactNode;
}) => (
  <Button
    nativeButton={false}
    render={
      <Link
        params={{ clientId }}
        search={tab === "status" ? {} : { tab }}
        to="/organizations/$clientId/setup"
      />
    }
    size="sm"
    variant="ghost"
  >
    {children}
  </Button>
);

/** The way over to something outside the admin, in a new tab. */
const OutLink = ({ href, label }: { href: string; label: string }) => (
  <Button
    nativeButton={false}
    render={
      <a
        aria-label={`${label}, in a new tab`}
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      />
    }
    size="sm"
    variant="ghost"
  >
    {label}
    <ExternalLinkIcon data-icon="inline-end" />
  </Button>
);

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
const secretsWaiting = (account: ClientSetup["account"]): boolean =>
  account?.rotatedAt !== null &&
  account?.rotatedAt !== undefined &&
  (account.rotationLiveAt === null ||
    account.rotationLiveAt < account.rotatedAt);

const needsOf = (setup: ClientSetup): PlatformNeed[] => {
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

const standingDot: Record<Standing, string> = {
  setup: "bg-foreground",
  healthy: "bg-status-agreed",
  attention: "bg-status-attention",
  offboarded: "bg-border",
};

const StandingMark = ({ standing }: { standing: Standing }) => (
  <span
    className={cn(
      "flex items-center gap-2",
      standing === "attention" && "text-status-attention"
    )}
  >
    <span
      aria-hidden
      className={cn("size-2 flex-none rounded-full", standingDot[standing])}
    />
    {standingWords[standing]}
  </span>
);

/** The release its core runs: the one its people meet. */
const releaseOf = (setup: ClientSetup): string | null =>
  setup.workers.find(({ worker }) => worker === "core")?.releaseId ?? null;

// The tabs.

/** Its address, how it stands, its release and channel, and the ways over to the admin and Cloudflare. */
const Header = ({
  clientId,
  setup,
  needs,
}: {
  clientId: string;
  setup: ClientSetup;
  needs: PlatformNeed[];
}) => {
  const { provisioning } = setup;
  const runs = releaseOf(setup);
  const { client } = provisioning;
  return (
    <section
      aria-label="How it stands"
      className="bg-card flex flex-col gap-3 rounded-xl border px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium">
          {provisioning.hostname ?? clientId}
        </span>
        <span className="text-muted-foreground flex flex-wrap items-center gap-x-2">
          <StandingMark standing={standingOf(setup, needs)} />
          {runs === null ? null : (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono text-xs">{runs}</span>
            </>
          )}
          {client === null ? null : (
            <>
              <span aria-hidden>·</span>
              <span>{channelWords[client.channel]}</span>
            </>
          )}
          {client?.pinnedReleaseId === null ||
          client?.pinnedReleaseId === undefined ? null : (
            <Badge variant="outline">Pinned</Badge>
          )}
        </span>
      </div>
      <div className="-mx-2.5 flex flex-wrap items-center gap-1 sm:mx-0">
        {provisioning.hostname === null ||
        client?.status !== "active" ? null : (
          <>
            <OutLink
              href={`https://${provisioning.hostname}`}
              label="Open its Grasp"
            />
            <OutLink
              href={`https://${provisioning.hostname}/settings/audit`}
              label="Its activity"
            />
          </>
        )}
      </div>
    </section>
  );
};

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
    <span className="flex flex-col items-end gap-1">
      <Button disabled={busy} onClick={retry} size="sm" variant="outline">
        Retry now
      </Button>
      {failure === null ? null : (
        <span className="text-destructive text-sm" role="alert">
          {failure}
        </span>
      )}
    </span>
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
    <span className="flex flex-col items-end gap-1">
      <Button disabled={busy} onClick={retry} size="sm" variant="outline">
        Retry
      </Button>
      {failure === null ? null : (
        <span className="text-destructive text-sm" role="alert">
          {failure}
        </span>
      )}
    </span>
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
        <TabLink clientId={clientId} tab="settings">
          Its settings
        </TabLink>
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
const placedOf = (hosting: ClientHostingView | null): boolean =>
  hosting !== null &&
  (hosting.placement !== null || hosting.operation !== null);

/** Milliseconds as seconds, to one decimal. */
const secondsOf = (ms: number | null): string =>
  ms === null ? "No answers to time" : `up to ${(ms / 1000).toFixed(1)} s`;

/**
 * How its Stephen fares in the chat apps, as the admin's watch last read
 * it (src/clients/watch.ts): a line a signal, the ones over their bar
 * marked, as staff were told of them.
 */
const StephenWatched = ({ setup }: { setup: ClientSetup }) => {
  const { watched } = setup;
  if (watched === null) {
    return null;
  }
  const { signals, readAt } = watched;
  const over = overBars(signals);
  return (
    <Section
      description={`Over the last ${signals.hours} hours, as the admin's hourly watch read it at ${formatTime(readAt)}.`}
      title="Stephen"
    >
      <Facts
        rows={[
          { label: "Answered", value: String(signals.answered) },
          {
            label: "Answer time",
            value: `Median ${secondsOf(signals.p50Ms)}, 9 in 10 ${secondsOf(signals.p90Ms)}`,
            attention: over.has("stephen_slow"),
          },
          {
            label: "Turns failed",
            value: String(signals.failed),
            attention: over.has("stephen_failing"),
          },
          {
            label: "Busy",
            value: String(signals.busy),
            attention: over.has("stephen_busy"),
          },
          {
            label: "Requests refused",
            value: String(signals.refused),
            attention: over.has("stephen_refused"),
          },
          {
            label: "Sends failed",
            value: String(signals.sendFailed),
            attention: over.has("stephen_sends_failing"),
          },
          {
            label: "Uninstalled",
            value: String(signals.uninstalled),
            attention: over.has("stephen_uninstalled"),
          },
          {
            label: "Need a new sign-in",
            value: `${signals.companyAgain} of the company's connections, ${signals.personalAgain} of people's own`,
            attention: over.has("stephen_connections_again"),
          },
        ]}
      />
    </Section>
  );
};

/**
 * Its AI in one line, as its core reports it from real calls: which
 * provider its organization connected, and whether it answers. Read only:
 * the organization's admins connect and change providers in their own
 * Settings.
 */
const AiStatus = ({ status }: { status: Promise<AiStatusReport | null> }) => (
  <Section
    description="Its admins connect a provider in their own Settings."
    title="AI"
  >
    <CardContent>
      <Await fallback={<p>AI: reading its core…</p>} promise={status}>
        {(report) => {
          const grasp = graspAiLine(report);
          return (
            <>
              <p>{aiStatusLine(report)}</p>
              {grasp === null ? null : (
                <p
                  className={
                    report?.graspAi?.reached === true
                      ? "text-status-attention"
                      : undefined
                  }
                >
                  {grasp}
                </p>
              )}
            </>
          );
        }}
      </Await>
    </CardContent>
  </Section>
);

/** Whether it runs the shared secrets in Secrets Store now, in words. */
const sharedSecretsWords = (current: boolean | null): string => {
  if (current === null) {
    return "Whether it runs the shared secrets in Secrets Store now can’t be told: the store or its account couldn’t be read, or nothing is live on it yet.";
  }
  return current
    ? "It runs the shared secrets in Secrets Store now."
    : "It doesn’t run the shared secrets in Secrets Store now: its next deploy, which the reconciler starts by itself, brings it up to date.";
};

/** What its account runs, read from Cloudflare when staff ask. */
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
  let said: ReactNode = "What Cloudflare says runs.";
  if (drift === "failed") {
    said = "Its account couldn’t be read. Try again in a while.";
  } else if (drift !== null) {
    said = (
      <span
        className={cn(
          drift.state !== "in_sync" &&
            drift.state !== "unknown" &&
            "text-status-attention"
        )}
      >
        {driftWords[drift.state]}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-3 border-t px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{said}</span>
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
          <p className="text-muted-foreground">
            {sharedSecretsWords(drift.sharedSecretsCurrent)}
          </p>
          <div className="@container -mx-5">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead variant="card">Worker</TableHead>
                  <TableHead variant="card">Made live</TableHead>
                  <TableHead variant="card">Running</TableHead>
                  <TableHead className="hidden @xl:table-cell" variant="card">
                    State
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drift.workers.map((worker) => (
                  <TableRow key={worker.worker}>
                    <TableCell variant="card">
                      <span className="font-mono text-xs">
                        {worker.scriptName}
                      </span>
                    </TableCell>
                    <TableCell variant="card">
                      <span className="font-mono text-xs">
                        {worker.recorded === null
                          ? "–"
                          : shortVersion(worker.recorded)}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal" variant="card">
                      <span className="font-mono text-xs">
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
                    <TableCell
                      className="hidden whitespace-normal @xl:table-cell"
                      variant="card"
                    >
                      {driftWords[worker.state]}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      ) : null}
    </div>
  );
};

/**
 * What runs in its account: each Worker as the admin made it live, what
 * Cloudflare says runs when staff ask, and under a fold what its deploys
 * keep there. Nothing before anything is live.
 */
const Workers = ({
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
  const kept =
    resources === null
      ? []
      : [
          ...resources.databases.map((name) => ({ kind: "Database", name })),
          ...resources.buckets.map((name) => ({ kind: "Files", name })),
        ];
  return (
    <Section title="Its Workers">
      <div className="@container border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Worker</TableHead>
              <TableHead className="hidden @lg:table-cell" variant="card">
                Release
              </TableHead>
              <TableHead className="hidden @2xl:table-cell" variant="card">
                Version
              </TableHead>
              <TableHead className="text-right" variant="card">
                Made live
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workers.map((worker) => (
              <TableRow key={worker.worker}>
                <TableCell variant="card">
                  <span className="flex flex-col">
                    <span className="capitalize">{worker.worker}</span>
                    <span className="text-muted-foreground font-mono text-xs">
                      {worker.scriptName}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="hidden @lg:table-cell" variant="card">
                  <span className="font-mono text-xs">
                    {worker.releaseId ?? "–"}
                  </span>
                </TableCell>
                <TableCell className="hidden @2xl:table-cell" variant="card">
                  <span className="font-mono text-xs">
                    {worker.versionId === null
                      ? "–"
                      : shortVersion(worker.versionId)}
                  </span>
                </TableCell>
                <TableCell className="text-right" variant="card">
                  <span className="tabular-nums">
                    {worker.deployedAt === null
                      ? "–"
                      : dayOf(worker.deployedAt)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <WhatRuns clientId={clientId} />
      {kept.length === 0 ? null : (
        <Collapsible>
          <div className="border-t px-5 py-3">
            <CollapsibleTrigger render={<Button size="sm" variant="ghost" />}>
              What it keeps
              <ChevronDownIcon data-icon="inline-end" />
            </CollapsibleTrigger>
          </div>
          {/* Kept on the page while folded: found by the page's search. */}
          <CollapsibleContent keepMounted>
            <ul className="flex flex-col">
              {kept.map(({ kind, name }) => (
                <li
                  className="flex items-baseline justify-between gap-4 border-t px-5 py-3"
                  key={`${kind}-${name}`}
                >
                  <span>{kind}</span>
                  <span className="text-muted-foreground font-mono text-xs">
                    {name}
                  </span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Section>
  );
};

/** What its account's live read depends on: the versions the admin made live, and its last deploy's standing. */
const liveKeyOf = (setup: ClientSetup): string =>
  [
    ...setup.workers.map(({ worker, versionId }) => `${worker}:${versionId}`),
    setup.deploy?.status ?? "none",
  ].join(" ");

const Status = ({
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
  const active = setup.provisioning.client?.status === "active";
  return (
    <>
      <Header clientId={clientId} needs={needs} setup={setup} />
      {progress !== null && showsProgress(progress) ? (
        <ProvisioningProgressView progress={progress}>
          <StoppedAction clientId={clientId} needs={needs} setup={setup} />
        </ProvisioningProgressView>
      ) : null}
      {needs.length > 0 ? (
        <Section title="What needs a look">
          <ul className="flex flex-col">
            {needs.map((need) => (
              <li
                className="flex flex-col items-start gap-2 border-t px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                key={need.kind}
              >
                <span className="flex min-w-0 items-start gap-3">
                  <span
                    aria-hidden
                    className="bg-status-attention mt-1.5 size-2 flex-none rounded-full"
                  />
                  <span>{needWords(need)}</span>
                </span>
                <NeedAction clientId={clientId} need={need} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {active ? (
        // Read again once what it runs changed: a deploy that ended.
        <LiveNumbers clientId={clientId} key={liveKeyOf(setup)} />
      ) : null}
      {active ? <AiStatus status={aiStatus} /> : null}
      <StephenWatched setup={setup} />
      <Workers clientId={clientId} setup={setup} />
    </>
  );
};

/** What a channel change records besides. */
const channelSchema = z.object({ channel: z.enum(channelIds) });

/** What setting each sealed secret did, for its log. */
const sealedSecretWords: Record<SealedSecretName, string> = {
  TEAMS_BOT_SECRET: "Set its Teams bot's secret.",
  SLACK_BOT_TOKEN: "Set its Slack app's bot token.",
  SLACK_SIGNING_SECRET: "Set its Slack app's signing secret.",
};

/** Whether `target` names a sealed secret. */
const isSealedSecretName = (
  target: string | null
): target is SealedSecretName =>
  target !== null && Object.hasOwn(sealedSecretWords, target);

/** What staff did by hand, in a sentence. */
/** What staff did by hand that needs nothing of its event to say, in a sentence. */
const plainEventWords: Readonly<Record<string, string>> = {
  "client.create": "Added it.",
  "client.rotate_secrets": "Rotated its secrets.",
  "client.sign_in": "Changed how its people sign in.",
  "client.teams_bot": "Changed its Teams bot.",
  "client.staff_window": "Opened or closed Grasp's staff window.",
  "client.retry": "Retried its deploy.",
  "client.offboard": "Offboarded it.",
};

/** A move to another channel, in a sentence, from what its event records. */
const channelChangeWords = (detail: string | null): string => {
  const channel = channelSchema.safeParse(JSON.parse(detail ?? "null")).data
    ?.channel;
  return channel === undefined
    ? "Moved it to another channel."
    : `Moved it to ${channelWords[channel]}.`;
};

/** What staff did by hand, in a sentence. */
const eventWords = ({
  action,
  target,
  detail,
}: Pick<HistoryEntry, "action" | "target" | "detail">): string => {
  switch (action) {
    case "client.place": {
      return `Placed it in ${target ?? "a hosting destination"}.`;
    }
    case "client.provision_placed": {
      return `Started provisioning it on ${target ?? "a release"}.`;
    }
    case "client.channel": {
      return channelChangeWords(detail);
    }
    case "client.pin": {
      return `Pinned it to ${target ?? "a release"}.`;
    }
    case "client.unpin": {
      return "Let it follow its channel again.";
    }
    case "client.sealed_secret": {
      return isSealedSecretName(target)
        ? sealedSecretWords[target]
        : "Set one of its secrets.";
    }
    case "client.apply_settings": {
      return "Applied its settings.";
    }
    case "client.stripe_customer": {
      return target === null
        ? "Unlinked it from Stripe."
        : `Linked it to ${target} in Stripe.`;
    }
    case "client.attio_company": {
      return target === null
        ? "Unlinked it from Attio."
        : `Linked it to ${target} in Attio.`;
    }
    default: {
      return plainEventWords[action] ?? action;
    }
  }
};

/** The step a provisioning event is the end of (src/hosting/operation.ts, `provisionSteps`). */
const provisionStepOf =
  /^provision\.(?<step>validated|resources|migrations|connect|core|probe|route)$/u;

/** What the admin did by itself, in a sentence; null for an action it has no words for. */
const systemEventWords = ({
  action,
  target,
}: Pick<HistoryEntry, "action" | "target">): string | null => {
  const on = target === null ? "" : ` of ${target}`;
  switch (action) {
    case "deploy.start": {
      return `Started its deploy${on}.`;
    }
    case "deploy.done": {
      return `Its deploy${on} is live.`;
    }
    case "deploy.fail": {
      return `Its deploy${on} failed.`;
    }
    case "provision.start": {
      return `Started setting it up${target === null ? "" : ` on ${target}`}.`;
    }
    case "provision.done": {
      return `Set it up${target === null ? "" : ` on ${target}`}.`;
    }
    case "provision.fail": {
      return "Its setting up stopped.";
    }
    case "client.rotation_live": {
      return "Its rotated secrets went live.";
    }
    default: {
      const step = provisionStepOf.exec(action)?.groups?.step;
      return step === undefined ? null : `Its ${step} step is done.`;
    }
  }
};

/** An error's code in what an event records besides, when it records one. */
const errorSchema = z.object({ error: z.string() });
const errorOf = (detail: string | null): string | null => {
  try {
    return (
      errorSchema.safeParse(JSON.parse(detail ?? "null")).data?.error ?? null
    );
  } catch {
    return null;
  }
};

/** One event of its history: what happened in a sentence, or its action as the log names it. */
const HistoryRow = ({ entry }: { entry: HistoryEntry }) => {
  const words = systemEventWords(entry) ?? eventWords(entry);
  const said = words !== entry.action;
  const error = errorOf(entry.detail);
  return (
    <li className="flex items-baseline justify-between gap-4 border-t px-5 py-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        {said ? (
          <span>{words}</span>
        ) : (
          <span className="font-mono text-xs break-all">
            {entry.target === null
              ? entry.action
              : `${entry.action} ${entry.target}`}
          </span>
        )}
        <span className="text-muted-foreground text-xs">
          {entry.actor === "system" ? "Grasp, by itself" : entry.actor}
          {error === null ? null : (
            <>
              {" · "}
              <ErrorCode code={error} />
            </>
          )}
        </span>
      </span>
      <span className="text-muted-foreground flex-none text-xs tabular-nums">
        {formatTime(entry.at)}
      </span>
    </li>
  );
};

/** Everything the admin's audit log keeps of it, the newest first. */
const History = ({ setup }: { setup: ClientSetup }) => (
  <Section description="Times in UTC." title="Its history">
    {setup.history.length === 0 ? (
      <Quiet>Nothing yet.</Quiet>
    ) : (
      <ul className="flex flex-col">
        {setup.history.map((entry) => (
          <HistoryRow entry={entry} key={entry.id} />
        ))}
      </ul>
    )}
  </Section>
);

/** Its last deploy, in a few words. */
const deployFact = (deploy: NonNullable<ClientSetup["deploy"]>): string =>
  `${deploy.releaseId}: ${deployWords[deploy.status]}${deploy.error === null ? "" : ` (${deploy.error})`}`;

const Releases = ({
  clientId,
  setup,
  imported,
  refresh,
}: {
  clientId: string;
  setup: ClientSetup;
  /** Every imported release, newest first, to pin it to. */
  imported: readonly { id: string; notes: string }[];
  refresh: Refresh;
}) => {
  const { provisioning, releases, deploy, target } = setup;
  const { client } = provisioning;
  const runs = releaseOf(setup);
  const pinned = client?.pinnedReleaseId ?? null;
  return (
    <>
      <Section
        description="A pinned company stays on its release: promotions skip it."
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
            {
              label: "Runs now",
              value:
                runs === null ? (
                  "–"
                ) : (
                  <span className="font-mono text-xs">{runs}</span>
                ),
            },
            {
              label: "Should run",
              value:
                target === null ? (
                  "No release on its channel yet"
                ) : (
                  <span className="font-mono text-xs">{target}</span>
                ),
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
          <CardContent>
            <ChannelChange
              channel={client.channel}
              clientId={clientId}
              refresh={refresh}
            />
            {/* Only a live company is pinned: one being set up gets the release it was added with. */}
            {client.status === "active" ? (
              <PinRelease
                clientId={clientId}
                pinned={pinned}
                refresh={refresh}
                releases={imported}
              />
            ) : null}
          </CardContent>
        )}
      </Section>
      <Section
        action={
          <Button
            nativeButton={false}
            render={<Link to="/platform/releases" />}
            size="sm"
            variant="ghost"
          >
            All releases
          </Button>
        }
        description={
          setup.moreReleases
            ? `The latest ${releases.length}: older ones are under all releases.`
            : undefined
        }
        title="Recent releases"
      >
        {releases.length === 0 ? (
          <Quiet>None imported yet.</Quiet>
        ) : (
          <ul className="flex flex-col">
            {releases.map((release) => (
              <li
                className="flex flex-col gap-1.5 border-t px-5 py-3"
                key={release.id}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <Link
                    className="hover:text-foreground font-mono text-xs underline underline-offset-4"
                    params={{ releaseId: release.id }}
                    to="/platform/releases/$releaseId"
                  >
                    {release.id}
                  </Link>
                  <span className="text-muted-foreground">
                    {dayOf(release.builtAt)}
                  </span>
                  {release.id === runs ? (
                    <Badge variant="secondary">Runs this</Badge>
                  ) : null}
                  {release.id === pinned ? (
                    <Badge variant="outline">Pinned</Badge>
                  ) : null}
                </span>
                {release.notes === "" ? null : (
                  <span className="text-muted-foreground">{release.notes}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
};

/** Who set client's sealed secret `name` and when, as a row; null while it isn't set. */
const sealedRow = (
  setup: ClientSetup,
  name: SealedSecretName,
  label: string
) => {
  const secret = setup.sealedSecrets.find((each) => each.name === name);
  return secret === undefined
    ? null
    : { label, value: `Set on ${dayOf(secret.setAt)} by ${secret.setBy}` };
};

/** Who set `rows` and when, and whether they're live yet; `none` while none is set. */
const SealedFacts = ({
  setup,
  rows,
  none,
}: {
  setup: ClientSetup;
  rows: ({ label: string; value: string } | null)[];
  none: string;
}) => {
  const set = rows.filter((row) => row !== null);
  if (set.length === 0) {
    return <Quiet>{none}</Quiet>;
  }
  return (
    <Facts
      rows={[
        ...set,
        ...(setup.configPending
          ? [{ label: "Live", value: "With the next deploy", attention: true }]
          : []),
      ]}
    />
  );
};

/**
 * The client's own Teams bot: its app id, tenant and secret's expiry, and
 * whether its secret is set; setting each, and its app package for its
 * IT, under a fold, as most companies never have one.
 */
const TeamsBotSection = ({
  clientId,
  setup,
  refresh,
}: {
  clientId: string;
  setup: ClientSetup;
  refresh: Refresh;
}) => {
  const bot = setup.teamsBot;
  const botSecret = setup.sealedSecrets.find(
    ({ name }) => name === "TEAMS_BOT_SECRET"
  );
  const none = bot === null && botSecret === undefined;
  return (
    <Collapsible>
      <Section
        action={
          <CollapsibleTrigger render={<Button size="sm" variant="outline" />}>
            {none ? "Set up" : "Change"}
          </CollapsibleTrigger>
        }
        title="Its Teams bot"
      >
        {none ? (
          <Quiet>No bot set.</Quiet>
        ) : (
          <Facts
            rows={[
              ...(bot === null
                ? []
                : [
                    { label: "App id", value: bot.appId },
                    { label: "Tenant", value: bot.tenantId },
                    {
                      label: "Secret expires",
                      value: formatDate(bot.secretExpiresOn),
                    },
                  ]),
              {
                label: "Secret",
                value:
                  botSecret === undefined
                    ? "Not set"
                    : `Set on ${dayOf(botSecret.setAt)} by ${botSecret.setBy}`,
                attention: botSecret === undefined,
              },
              ...(setup.configPending
                ? [
                    {
                      label: "Live",
                      value: "With the next deploy",
                      attention: true,
                    },
                  ]
                : []),
            ]}
          />
        )}
        {/* Kept on the page while folded: what staff typed stays between refreshes. */}
        <CollapsibleContent keepMounted>
          {bot === null ? null : (
            <CardContent>
              <TeamsPackageDownload clientId={clientId} />
            </CardContent>
          )}
          <TeamsBotChange bot={bot} clientId={clientId} refresh={refresh} />
          <SealedSecretChange
            clientId={clientId}
            description="The bot app's client secret, from its registration in the company's own Entra. It is sealed and never shown again, here or anywhere; its connect gets it with the next deploy."
            label="Client secret"
            name="TEAMS_BOT_SECRET"
            refresh={refresh}
            set={botSecret !== undefined}
          />
        </CollapsibleContent>
      </Section>
    </Collapsible>
  );
};

/** Copying the manifest its Slack app is created from (src/clients/slack-app.ts). */
const CopySlackManifest = ({
  hostname,
  clientName,
}: {
  hostname: string;
  clientName: string;
}) => (
  <div className="flex flex-wrap items-center gap-3 border-t px-5 py-4">
    <Button
      onClick={() => {
        void navigator.clipboard.writeText(
          JSON.stringify(slackAppManifest(hostname, clientName), null, 2)
        );
      }}
      size="sm"
      variant="outline"
    >
      <CopyIcon />
      Copy app manifest
    </Button>
    <span className="text-muted-foreground text-sm">
      In the company&apos;s Slack, create an app from it, install it, then set
      its bot token and signing secret below.
    </span>
  </div>
);

/**
 * The client's own Slack app: whether its bot token and signing secret
 * are set; the manifest to create it from and setting them, under a fold.
 */
const SlackAppSection = ({
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
  const token = sealedRow(setup, "SLACK_BOT_TOKEN", "Bot token");
  const signing = sealedRow(setup, "SLACK_SIGNING_SECRET", "Signing secret");
  return (
    <Collapsible>
      <Section
        action={
          <CollapsibleTrigger render={<Button size="sm" variant="outline" />}>
            {token === null && signing === null ? "Set up" : "Change"}
          </CollapsibleTrigger>
        }
        title="Its Slack app"
      >
        <SealedFacts
          none="No bot token or signing secret set."
          rows={[token, signing]}
          setup={setup}
        />
        {/* Kept on the page while folded: what staff typed stays between refreshes. */}
        <CollapsibleContent keepMounted>
          {hostname === null ? (
            <Quiet>Give the admin a domain first: the app sends to it.</Quiet>
          ) : (
            <>
              <Facts
                rows={[
                  { label: "Request URL", value: slackRequestUrl(hostname) },
                ]}
              />
              <CopySlackManifest clientName={clientName} hostname={hostname} />
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
        </CollapsibleContent>
      </Section>
    </Collapsible>
  );
};

/**
 * Where its Grasp is hosted: the destination it is placed in, or where it
 * would go, its operation there, and offboarding it. For a company being
 * set up, or one placed already.
 */
const HostingSection = ({
  setup,
  hosting,
}: {
  setup: ClientSetup;
  hosting: ClientHostingView | null;
}) =>
  hosting !== null &&
  (placedOf(hosting) ||
    setup.provisioning.client?.status === "provisioning") ? (
    <Section title="Hosting">
      <div className="border-t px-5 py-4">
        <ClientHosting view={hosting} />
      </div>
    </Section>
  ) : null;

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
  return (
    <>
      <Section title="How its people sign in">
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
              ...(setup.configPending
                ? [
                    {
                      label: "Live",
                      value: "With the next deploy",
                      attention: true,
                    },
                  ]
                : []),
            ]}
          />
        )}
        {client === null ? null : (
          <SignInChange clientId={clientId} refresh={refresh} signIn={signIn} />
        )}
      </Section>
      <Section
        description="While it is open, Grasp's staff can bring in the kickoff and steer the onboarding from here. It reaches the company once its settings are applied, and its own admin can end it."
        title="Grasp's staff window"
      >
        <StaffWindowChange
          canChange={client !== null && signIn !== null}
          clientId={clientId}
          configPending={setup.configPending}
          refresh={refresh}
          setup={setup.staffWindow}
        />
      </Section>
      {client === null ? null : (
        <Section title="Applying its settings">
          <ApplySettings
            active={client.status === "active"}
            clientId={clientId}
            configPending={setup.configPending}
            pinned={client.pinnedReleaseId}
            refresh={refresh}
          />
        </Section>
      )}
      <Section
        description="New ones reach it with its next deploy; the old ones keep working a while after."
        title="Its secrets"
      >
        {account === null ? (
          <Quiet>Made when it is set up.</Quiet>
        ) : (
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
        )}
        {account === null ? null : (
          <RotateSecrets clientId={clientId} refresh={refresh} />
        )}
      </Section>
      {client === null ? null : (
        <>
          <TeamsBotSection
            clientId={clientId}
            refresh={refresh}
            setup={setup}
          />
          <SlackAppSection
            clientId={clientId}
            clientName={client.name}
            refresh={refresh}
            setup={setup}
          />
        </>
      )}
      <HostingSection hosting={hosting} setup={setup} />
    </>
  );
};

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
  const navigate = useNavigate();
  const refresh = useRefreshSetup();
  useFollow(setup, hosting, refresh);
  const needs = needsOf(setup);
  return (
    <Tabs
      onValueChange={(value: SetupTab) => {
        void navigate({
          to: "/organizations/$clientId/setup",
          params: { clientId },
          search: value === "status" ? {} : { tab: value },
        });
      }}
      value={tab}
    >
      <TabsList aria-label="Its platform" variant="line">
        {setupTabs.map((each) => (
          <TabsTrigger key={each} value={each}>
            {tabWords[each]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="status">
        <div className="flex flex-col gap-6 pt-4">
          <Status
            aiStatus={ai}
            clientId={clientId}
            needs={needs}
            progress={progress}
            setup={setup}
          />
        </div>
      </TabsContent>
      <TabsContent value="history">
        <div className="flex flex-col gap-6 pt-4">
          <History setup={setup} />
        </div>
      </TabsContent>
      <TabsContent value="releases">
        <div className="flex flex-col gap-6 pt-4">
          <Releases
            clientId={clientId}
            imported={releases}
            refresh={refresh}
            setup={setup}
          />
        </div>
      </TabsContent>
      <TabsContent value="settings">
        <div className="flex flex-col gap-6 pt-4">
          <Settings
            clientId={clientId}
            hosting={hosting}
            refresh={refresh}
            setup={setup}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
};
