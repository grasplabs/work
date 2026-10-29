/**
 * An organization's Setup: the company's own Grasp as the admin runs
 * it, from the contract to every day after, ported from the prototype
 * (grasplabs/prototype `components/admin/org-setup.tsx`,
 * `platform-parts.tsx` and `platform-words.ts`). Unlike the other
 * sections it reads the admin's own records (src/clients/setup.ts):
 * how it stands and what needs a look, how it runs from its address to
 * its data, every deploy step by step, what runs in its Cloudflare
 * account, the releases it gets, and how its people sign in.
 *
 * And what someone at Grasp does to it, where it shows
 * (src/admin/setup-actions.tsx): resume setting it up or confirm Workers
 * Paid, place it in a hosting destination, pin it, move it to another
 * ring, roll it back, change how its people sign in, apply its settings,
 * rotate its secrets. Its account's numbers now (reach, errors, drift,
 * shared secrets, cost) are read live once the section shows; what the
 * admin doesn't keep day by day says so rather than show a number.
 */
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import type { ModelSpendReport } from "@grasp-os/shared/model-spend-report";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
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
import { Await, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CopyIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import type { ClientModelTransport } from "../clients/model-transport.ts";
import { QuotaPolicyCard } from "../clients/quota-policy-card.tsx";
import type { ClientQuotaPolicy } from "../clients/quota-policy.ts";
import type { ClientSetup } from "../clients/setup.ts";
import { slackAppManifest, slackRequestUrl } from "../clients/slack-app.ts";
import { overBars } from "../clients/watch-signals.ts";
import type { SealedSecretName } from "../deploy/sealed-secrets.ts";
import { ClientHosting } from "../hosting/client-hosting.tsx";
import type { ClientHostingView } from "../hosting/placement.ts";
import { operationErrorWords } from "../hosting/words.ts";
import type { ProvisioningView } from "../provision/queries.ts";
import { formatTime } from "../releases/format.ts";
import type { ClientDriftState } from "../rollout/drift.ts";
import { fetchDrift } from "../rollout/functions.ts";
import type { DriftCheck } from "../rollout/functions.ts";
import { AiSection } from "./ai-section.tsx";
import { ringWords } from "./platform-parts.tsx";
import { sectionTo } from "./sections.ts";
import type { OrgSection } from "./sections.ts";
import {
  ApplySettings,
  History,
  LiveNumbers,
  PinRelease,
  ModelSpendCeilingChange,
  RingChange,
  RollBack,
  RotateSecrets,
  SignInChange,
  SealedSecretChange,
  TeamsBotChange,
  TeamsPackageDownload,
  TestAlert,
  useRefreshSetup,
} from "./setup-actions.tsx";
import type { Refresh } from "./setup-actions.tsx";
import { Body, ErrorCode, Facts, Quiet, SetupSection } from "./setup-parts.tsx";
import { euros, formatDate } from "./words.ts";

/** The section's tabs, in order: how it stands first. */
export const setupTabs = [
  "status",
  "history",
  "resources",
  "releases",
  "settings",
] as const;
export type SetupTab = (typeof setupTabs)[number];

const tabWords: Record<SetupTab, string> = {
  status: "Status",
  history: "History",
  resources: "Resources",
  releases: "Releases",
  settings: "Settings",
};

/** A day as the section says it: "2 Sep 2026". */
const dayOf = (at: Date): string => formatDate(at.toISOString().slice(0, 10));

/** A version's id, short. */
const shortVersion = (id: string): string => id.slice(0, 8);

// The words of the admin's own records, as staff read them.

type Target = NonNullable<ClientSetup["rollout"]>["target"];

const targetWords: Record<Target, string> = {
  pending: "Waits for its ring",
  deploying: "Deploying",
  done: "On it",
  failed: "Failed",
  rolled_back: "Rolled back",
  skipped: "Skipped",
  stopped: "Stopped",
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
  | { kind: "provisioning"; view: ProvisioningView }
  | { kind: "rollout"; rollout: NonNullable<ClientSetup["rollout"]> }
  | { kind: "secrets" }
  | { kind: "settings" }
  | { kind: "behind"; releases: number };

/** A company this many releases behind the newest, not pinned, needs a look. */
const behindAt = 2;

/** Whether its secrets rotated and no deploy has made them live since. */
const secretsWaiting = (account: ClientSetup["account"]): boolean =>
  account?.rotatedAt !== null &&
  account?.rotatedAt !== undefined &&
  (account.rotationLiveAt === null ||
    account.rotationLiveAt < account.rotatedAt);

const needsOf = (setup: ClientSetup): PlatformNeed[] => {
  const { provisioning, rollout, behind } = setup;
  const needs: PlatformNeed[] = [];
  if (provisioning.phase === "failed") {
    needs.push({ kind: "provisioning", view: provisioning });
  }
  if (rollout?.target === "failed" || rollout?.target === "rolled_back") {
    needs.push({ kind: "rollout", rollout });
  }
  const active = provisioning.client?.status === "active";
  if (active && secretsWaiting(setup.account)) {
    needs.push({ kind: "secrets" });
  }
  if (active && setup.configPending) {
    needs.push({ kind: "settings" });
  }
  // A pinned company stays behind on purpose.
  const pinned = provisioning.client?.pinnedReleaseId ?? null;
  if (pinned === null && behind !== null && behind >= behindAt) {
    needs.push({ kind: "behind", releases: behind });
  }
  return needs;
};

/** A need in a sentence. */
const needWords = (need: PlatformNeed): ReactNode => {
  if (need.kind === "provisioning") {
    const { view } = need;
    return view.stopped === null ? (
      "Setting it up stopped, and waits to be started again from Hosting."
    ) : (
      <>
        {`Setting it up stopped at its ${view.stopped.step} step: `}
        <ErrorCode code={view.stopped.error} />
        {` ${operationErrorWords(view.stopped.error)}`}
      </>
    );
  }
  if (need.kind === "rollout") {
    const { rollout } = need;
    const what =
      rollout.releaseId === null
        ? "The secrets rollout"
        : `The rollout of ${rollout.releaseId}`;
    const how =
      rollout.target === "failed" ? "failed for it" : "was rolled back for it";
    return rollout.error === null ? (
      `${what} ${how}.`
    ) : (
      <>
        {`${what} ${how}: `}
        <ErrorCode code={rollout.error} />
      </>
    );
  }
  if (need.kind === "secrets") {
    return "New secrets wait to reach it: the next deploy carries them.";
  }
  if (need.kind === "settings") {
    return "Changed settings wait to reach it: the next deploy carries them.";
  }
  return `${need.releases} releases behind the newest.`;
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

/** Its address, how it stands, its release and ring, and the ways over to the admin and Cloudflare. */
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
              <span>{ringWords(client.ring)}</span>
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
              href={`https://${provisioning.hostname}/activity`}
              label="Its activity"
            />
          </>
        )}
      </div>
    </section>
  );
};

/** One part of how a company's platform runs: what it is and what it does. */
const Part = ({
  name,
  does,
  release,
}: {
  name: string;
  does: string;
  release?: string | null;
}) => (
  <div className="bg-background flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border px-3 py-2.5">
    <span className="truncate font-medium">{name}</span>
    <span className="text-muted-foreground text-xs">{does}</span>
    {release === undefined || release === null ? null : (
      <span className="text-muted-foreground mt-auto pt-1 font-mono text-xs">
        {release}
      </span>
    )}
  </div>
);

const Onward = () => (
  <span
    aria-hidden
    className="text-muted-foreground flex flex-none items-center justify-center"
  >
    <ArrowDownIcon className="size-4 md:hidden" />
    <ArrowRightIcon className="hidden size-4 md:block" />
  </span>
);

/**
 * How a company's own Grasp runs, from its address to where its data is:
 * the router Grasp runs for every company, then in its own account core,
 * connect and what they keep, each Worker with its release.
 */
const HowItRuns = ({
  clientId,
  setup,
}: {
  clientId: string;
  setup: ClientSetup;
}) => {
  const releaseOfWorker = (worker: "core" | "connect") =>
    setup.workers.find((each) => each.worker === worker)?.releaseId ?? null;
  const { resources } = setup;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
        <Part
          does="Where its people sign in, with their own accounts."
          name={setup.provisioning.hostname ?? clientId}
        />
        <Onward />
        <Part
          does="Grasp’s own, in front of every company: sends each address to its account."
          name="Router"
        />
        <Onward />
        <Part
          does="The app, its chat and its workflows."
          name="Core"
          release={releaseOfWorker("core")}
        />
        <Onward />
        <Part
          does="Its connections to its apps, each call in a sandbox of its own."
          name="Connect"
          release={releaseOfWorker("connect")}
        />
      </div>
      {resources === null ? null : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {resources.databases.map((name) => (
            <Part does={name} key={`d1-${name}`} name="Database" />
          ))}
          {resources.buckets.map((name) => (
            <Part does={name} key={`r2-${name}`} name="Files" />
          ))}
          <Part does={resources.gateway} name="AI Gateway" />
        </div>
      )}
    </div>
  );
};

/** Done, still to do, or not known here: each step of the checklist. */
type CheckState = "done" | "todo" | "unknown";

interface ChecklistStep {
  id: string;
  label: string;
  state: CheckState;
  /** The section it is done in. */
  to: OrgSection;
  /** Why it is not known here. */
  why?: string;
}

const CheckMark = ({ state }: { state: CheckState }) => {
  if (state === "done") {
    return (
      <CheckIcon
        aria-hidden
        className="text-status-agreed mt-0.5 size-4 flex-none"
      />
    );
  }
  const Icon = state === "unknown" ? CircleDashedIcon : CircleIcon;
  return (
    <Icon
      aria-hidden
      className="text-muted-foreground mt-0.5 size-4 flex-none"
    />
  );
};

const checkSaid: Record<CheckState, string> = {
  done: "done",
  todo: "to do",
  unknown: "not known here",
};

/**
 * From the contract to the company working in it: what has to be in
 * place, in the order it comes. The contract and its agreements are known
 * once core holds them; until then they are not known here.
 */
const Checklist = ({
  clientId,
  setup,
  view,
  contractRead,
}: {
  clientId: string;
  setup: ClientSetup;
  view: AdminView;
  contractRead: boolean;
}) => {
  const agreements = view.agreements.filter(({ state }) => state !== "none");
  const known: ChecklistStep[] = [
    {
      id: "contract",
      label: "The contract is signed",
      state: view.contract.status === "signed" ? "done" : "todo",
      to: "contract",
    },
    {
      id: "agreements",
      label: "The agreements are in place",
      state: agreements.every(({ state }) => state === "signed")
        ? "done"
        : "todo",
      to: "contract",
    },
    {
      id: "platform",
      label:
        "Its own platform is deployed, in its own Cloudflare account in the EU",
      state: setup.provisioning.client?.status === "active" ? "done" : "todo",
      to: "setup",
    },
    {
      id: "address",
      label:
        "Its address works, and its people sign in with their own accounts",
      state: view.stages.connected === "done" ? "done" : "todo",
      to: "integrations",
    },
    {
      id: "members",
      label: "Its admin invited the first people",
      state: view.members.length > 0 ? "done" : "todo",
      to: "members",
    },
    {
      id: "go",
      label: "Grasp gave its go, and the company works in it",
      state: view.open ? "done" : "todo",
      to: "steps",
    },
  ];
  // Until core holds the contract, neither it nor its agreements is known here.
  const steps = known.map((step): ChecklistStep =>
    !contractRead && step.to === "contract"
      ? { ...step, state: "unknown", why: "From Rooms, once it is connected." }
      : step
  );
  const done = steps.filter(({ state }) => state === "done").length;
  return (
    <SetupSection
      description={`${done} of ${steps.length} in place.`}
      title="From contract to go"
    >
      <ul className="flex flex-col">
        {steps.map((step) => (
          <li
            className="flex items-center justify-between gap-4 border-t px-5 py-3"
            key={step.id}
          >
            <span className="flex min-w-0 items-start gap-3">
              <CheckMark state={step.state} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={cn(
                    step.state === "done" && "text-muted-foreground"
                  )}
                >
                  {step.label}
                  <span className="sr-only">{`: ${checkSaid[step.state]}`}</span>
                </span>
                {step.why === undefined ? null : (
                  <span className="text-muted-foreground text-xs">
                    {step.why}
                  </span>
                )}
              </span>
            </span>
            {step.state === "todo" && step.to !== "setup" ? (
              <Button
                nativeButton={false}
                render={<Link params={{ clientId }} to={sectionTo[step.to]} />}
                size="sm"
                variant="ghost"
              >
                Open
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </SetupSection>
  );
};

/** Where what a need says is seen to: the rollout's page, or the tab it is done on. */
const NeedAction = ({
  clientId,
  need,
}: {
  clientId: string;
  need: PlatformNeed;
}) => {
  switch (need.kind) {
    case "rollout": {
      return (
        <Button
          nativeButton={false}
          render={
            <Link
              params={{ rolloutId: need.rollout.id }}
              to="/platform/rollouts/$rolloutId"
            />
          }
          size="sm"
          variant="ghost"
        >
          The rollout
        </Button>
      );
    }
    case "secrets":
    case "settings": {
      return (
        <TabLink clientId={clientId} tab="settings">
          Its settings
        </TabLink>
      );
    }
    case "behind": {
      return (
        <TabLink clientId={clientId} tab="releases">
          Its releases
        </TabLink>
      );
    }
    case "provisioning": {
      // Setting it up is seen to below, on this tab.
      return null;
    }
    default: {
      return need satisfies never;
    }
  }
};

/** Whether a company is in a hosting destination, or being provisioned in one. */
const placedOf = (hosting: ClientHostingView | null): boolean =>
  hosting !== null &&
  (hosting.placement !== null || hosting.operation !== null);

/**
 * Where its Grasp is hosted: the destination it is placed in, or where it
 * would go, and provisioning it there. For a company being set up, or
 * one placed already.
 */
const HostingSection = ({
  setup,
  hosting,
  releases,
}: {
  setup: ClientSetup;
  hosting: ClientHostingView | null;
  releases: readonly { id: string; notes: string }[];
}) =>
  hosting !== null &&
  (placedOf(hosting) ||
    setup.provisioning.client?.status === "provisioning") ? (
    <SetupSection
      description="The hosting policy it is held to, and the destination that meets it."
      title="Hosting"
    >
      <div className="border-t px-5 py-4">
        <ClientHosting releases={releases} view={hosting} />
      </div>
    </SetupSection>
  ) : null;

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
    <SetupSection
      description={`Over the last ${signals.hours} hours, as the admin's hourly watch read it at ${formatTime(readAt)}. Counts only. Each signal over its bar was posted to the staff alerts' channel.`}
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
            label: "Over budget",
            value: String(signals.overBudget),
            attention: over.has("stephen_over_budget"),
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
    </SetupSection>
  );
};

/** List prices in US dollars, to the cent, as the gateway counts them. */
const dollars = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
});

/**
 * This month's spend against the ceiling, as the gateway's ledger counts
 * it, or that it's unknown: never an estimate in its place.
 */
const spendWords = (
  report: ModelSpendReport | null,
  ceiling: number
): string => {
  if (report === null) {
    return `Ceiling: ${euros(ceiling)} a month. This month's spend: unknown, as its core couldn't be asked.`;
  }
  const share = Math.round((report.spent / ceiling) * 100);
  return `This month (${report.month}): ${dollars.format(report.spent)} of its ${euros(ceiling)} ceiling (${String(share)}%), as its gateway counts it, at the providers' list prices in US dollars.`;
};

/**
 * Its model spend: the ceiling its core's gateway holds it to, what this
 * month's use came to as far as its core counted it, and changing the
 * ceiling.
 */
const ModelSpend = ({
  clientId,
  ceiling,
  spend,
  refresh,
}: {
  clientId: string;
  ceiling: number;
  /** What its core's ledger charged its budget this month; null when unknown. */
  spend: Promise<ModelSpendReport | null>;
  refresh: Refresh;
}) => (
  <SetupSection
    description="What its model calls may cost in a calendar month. Its core's model gateway refuses a call that would go past it."
    title="Model spend"
  >
    <Body>
      <Await
        fallback={<p>{`Ceiling: ${euros(ceiling)} a month.`}</p>}
        promise={spend}
      >
        {(report) => <p>{spendWords(report, ceiling)}</p>}
      </Await>
      <ModelSpendCeilingChange
        ceiling={ceiling}
        clientId={clientId}
        refresh={refresh}
      />
    </Body>
  </SetupSection>
);

const Status = ({
  clientId,
  setup,
  needs,
  view,
  quotaPolicy,
  modelSpend,
  ai,
  hosting,
  releases,
  refresh,
}: {
  clientId: string;
  setup: ClientSetup;
  needs: PlatformNeed[];
  /** What its core answered, worked out; null when it didn't answer. */
  view: AdminView | null;
  /** Its quota policy, its core read live; null when it couldn't be read. */
  quotaPolicy: Promise<ClientQuotaPolicy | null>;
  /** Its spend this month as its core's ledger counts it, read live and not awaited; null when unknown. */
  modelSpend: Promise<ModelSpendReport | null>;
  /** Its AI, its core read live and not awaited; null when it couldn't be read. */
  ai: Promise<ClientModelTransport | null>;
  hosting: ClientHostingView | null;
  releases: readonly { id: string; notes: string }[];
  refresh: Refresh;
}) => (
  <>
    <Header clientId={clientId} needs={needs} setup={setup} />
    {needs.length > 0 ? (
      <SetupSection
        description="The most pressing first."
        title="What needs a look"
      >
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
      </SetupSection>
    ) : null}
    <HostingSection hosting={hosting} releases={releases} setup={setup} />
    {setup.provisioning.client === null ? null : (
      <AiSection
        active={setup.provisioning.client.status === "active"}
        ai={ai}
        clientId={clientId}
        configPending={setup.configPending}
        pinned={setup.provisioning.client.pinnedReleaseId}
        refresh={refresh}
      />
    )}
    {setup.account === null ? null : (
      <ModelSpend
        ceiling={setup.account.modelSpendCeiling}
        clientId={clientId}
        refresh={refresh}
        spend={modelSpend}
      />
    )}
    <SetupSection
      description="Read from its account now, and kept a minute. The admin doesn’t keep these day by day yet. Cost is an estimate for the calendar month: its Workers Paid plan past what it includes, and AI Gateway spend; not storage or Durable Objects."
      title="Its platform in numbers"
    >
      <LiveNumbers
        active={setup.provisioning.client?.status === "active"}
        clientId={clientId}
      />
    </SetupSection>
    {setup.provisioning.client?.status === "active" ? (
      // Its core read live, within the grid's deadline: the Setup shows
      // without waiting for it, and the section once it answers.
      <Await fallback={null} promise={quotaPolicy}>
        {(policy) =>
          policy === null ? null : <QuotaPolicyCard policy={policy} />
        }
      </Await>
    ) : null}
    <StephenWatched setup={setup} />
    <SetupSection
      description="From its address to where its data is. Everything after the router is in the company’s own Cloudflare account, in the EU."
      title="How it runs"
    >
      <div className="border-t px-5 py-4">
        {setup.workers.length === 0 ? (
          <p className="text-muted-foreground">
            Nothing runs yet. Once it is set up, this is what runs, and where.
          </p>
        ) : (
          <HowItRuns clientId={clientId} setup={setup} />
        )}
      </div>
    </SetupSection>
    {view === null ? null : (
      <Checklist
        clientId={clientId}
        contractRead={!view.unknown.contract}
        setup={setup}
        view={view}
      />
    )}
  </>
);

/** What a ring change records besides. */
const ringSchema = z.object({ ring: z.number() });
const ceilingChangeSchema = z.object({ to: z.number() });

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
  "client.model_transport": "Changed how it reaches its models.",
};

/** A change of its model spend ceiling, in a sentence. */
const ceilingWords = ({ detail }: ClientSetup["done"][number]): string => {
  const to = ceilingChangeSchema.safeParse(JSON.parse(detail ?? "null")).data
    ?.to;
  return to === undefined
    ? "Changed its model spend ceiling."
    : `Set its model spend ceiling to ${euros(to)} a month.`;
};

/** What staff did by hand, in a sentence. */
const eventWords = ({
  action,
  target,
  detail,
}: ClientSetup["done"][number]): string => {
  switch (action) {
    case "client.place": {
      return `Placed it in ${target ?? "a hosting destination"}.`;
    }
    case "client.provision_placed": {
      return `Started provisioning it on ${target ?? "a release"}.`;
    }
    case "client.ring": {
      const ring = ringSchema.safeParse(JSON.parse(detail ?? "null")).data
        ?.ring;
      return ring === undefined
        ? "Moved it to another ring."
        : `Moved it to ${ringWords(ring)}.`;
    }
    case "client.pin": {
      return `Pinned it to ${target ?? "a release"}.`;
    }
    case "client.unpin": {
      return "Let it follow the rollouts again.";
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

const Done = ({ setup }: { setup: ClientSetup }) => {
  const { done, history } = setup;
  return (
    <>
      {done.length > 0 ? (
        <SetupSection
          description="What someone at Grasp did to its platform by hand, as the admin’s audit log keeps it."
          title="Done here"
        >
          <ul className="flex flex-col">
            {done.map((event) => (
              <li
                className="flex items-baseline justify-between gap-4 border-t px-5 py-3"
                key={event.id}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>
                    {event.action === "client.model_spend_ceiling"
                      ? ceilingWords(event)
                      : eventWords(event)}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {event.actor}
                  </span>
                </span>
                <span className="text-muted-foreground flex-none text-xs tabular-nums">
                  {dayOf(event.at)}
                </span>
              </li>
            ))}
          </ul>
        </SetupSection>
      ) : null}
      <SetupSection
        description="Everything the admin’s audit log keeps of it, the newest first: what someone at Grasp did, and its provisioning, deploys and rollouts."
        title="Its history"
      >
        <History history={history} />
      </SetupSection>
    </>
  );
};

/** Whether it runs the shared secrets in Secrets Store now, in words. */
const sharedSecretsWords = (current: boolean | null): string => {
  if (current === null) {
    return "Whether it runs the shared secrets in Secrets Store now can’t be told: the store or its account couldn’t be read, or nothing is live on it yet.";
  }
  return current
    ? "It runs the shared secrets in Secrets Store now."
    : "It doesn’t run the shared secrets in Secrets Store now: a secrets rollout brings it up to date.";
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
  let said: ReactNode = "Read from its account when you ask.";
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

const Resources = ({
  clientId,
  setup,
}: {
  clientId: string;
  setup: ClientSetup;
}) => {
  const { provisioning, workers, resources } = setup;
  const { client } = provisioning;
  return (
    <>
      <SetupSection
        description="In the hosting destination it is placed in (Hosting, on its Status), in the EU: the company’s data stays in its own resources there."
        title="Its deployment"
      >
        <Facts
          rows={[
            { label: "Company", value: client.name },
            {
              label: "Address",
              value: provisioning.hostname ?? "No domain set in the admin",
            },
            { label: "Added by", value: client.createdBy ?? "–" },
            { label: "Added (UTC)", value: formatTime(client.createdAt) },
          ]}
        />
      </SetupSection>
      <SetupSection
        description="What the admin made live, and what Cloudflare says runs."
        title="Its Workers"
      >
        {workers.length === 0 ? (
          <Quiet>Nothing is live yet.</Quiet>
        ) : (
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
                    <TableCell
                      className="hidden @2xl:table-cell"
                      variant="card"
                    >
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
        )}
        {workers.length === 0 ? null : <WhatRuns clientId={clientId} />}
      </SetupSection>
      <SetupSection
        description="Found or made by every deploy, as the release it runs names them, all in the EU."
        title="What it keeps"
      >
        {resources === null ? (
          <Quiet>Nothing yet.</Quiet>
        ) : (
          <ul className="flex flex-col">
            {[
              ...resources.databases.map((name) => ({
                kind: "Database",
                name,
              })),
              ...resources.buckets.map((name) => ({ kind: "Files", name })),
              { kind: "AI Gateway", name: resources.gateway },
            ].map(({ kind, name }) => (
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
        )}
      </SetupSection>
    </>
  );
};

/** Where the latest rollout that reached it stands for it. */
const rolloutFact = (
  rollout: NonNullable<ClientSetup["rollout"]>
): ReactNode => (
  <Link
    className="hover:text-foreground underline underline-offset-4"
    params={{ rolloutId: rollout.id }}
    to="/platform/rollouts/$rolloutId"
  >
    {`${rollout.releaseId ?? "New secrets"}: ${targetWords[rollout.target].toLowerCase()}`}
  </Link>
);

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
  const { provisioning, releases, rollout } = setup;
  const { client } = provisioning;
  const runs = releaseOf(setup);
  const pinned = client?.pinnedReleaseId ?? null;
  return (
    <>
      <SetupSection
        description="A release goes out ring by ring, and waits after each for someone at Grasp. A pinned company stays on its release, whatever the rollouts."
        title="Where it gets releases"
      >
        <Facts
          rows={[
            {
              label: "Ring",
              value: client === null ? "–" : ringWords(client.ring),
            },
            {
              label: "Release",
              value:
                pinned === null
                  ? "Follows the rollouts"
                  : `Pinned to ${pinned}`,
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
              label: "The latest rollout",
              value: rollout === null ? "Not in one yet" : rolloutFact(rollout),
              attention:
                rollout?.target === "failed" ||
                rollout?.target === "rolled_back",
            },
          ]}
        />
        {client === null ? null : (
          <Body>
            <RingChange
              clientId={clientId}
              refresh={refresh}
              ring={client.ring}
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
          </Body>
        )}
        <RollBack clientId={clientId} refresh={refresh} rollout={rollout} />
      </SetupSection>
      <SetupSection
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
            ? `The latest ${releases.length} CI made, newest first: older ones are under all releases.`
            : "As CI made them, the newest first."
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
      </SetupSection>
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
 * The client's own Teams bot: its app id, tenant and secret's expiry, its
 * secret, setting each, and its app package for its IT.
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
  return (
    <SetupSection
      description="Its own Teams bot, registered in its own Entra: its connect sends as it and its core answers it, from the next deploy. The secret is kept sealed by the admin and given only to its connect."
      title="Its Teams bot"
    >
      {bot === null && botSecret === undefined ? (
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
      {bot === null ? null : (
        <Body>
          <TeamsPackageDownload clientId={clientId} />
        </Body>
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
    </SetupSection>
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
 * The client's own Slack app: the manifest to create it from, whether its
 * bot token and signing secret are set, and setting them.
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
    <SetupSection
      description="Its own Slack app, which sends to its core. The bot token is kept sealed and given only to its connect, the signing secret only to its core, with each deploy."
      title="Its Slack app"
    >
      {hostname === null ? (
        <Quiet>Give the admin a domain first: the app sends to it.</Quiet>
      ) : (
        <>
          <Facts
            rows={[{ label: "Request URL", value: slackRequestUrl(hostname) }]}
          />
          <CopySlackManifest clientName={clientName} hostname={hostname} />
        </>
      )}
      <SealedFacts
        none="No bot token or signing secret set."
        rows={[token, signing]}
        setup={setup}
      />
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
    </SetupSection>
  );
};

const Settings = ({
  clientId,
  setup,
  refresh,
}: {
  clientId: string;
  setup: ClientSetup;
  refresh: Refresh;
}) => {
  const { signIn, account } = setup;
  const { client } = setup.provisioning;
  const providers = [
    ...(signIn?.entraTenantId === undefined ? [] : ["Microsoft Entra ID"]),
    ...(signIn?.googleHostedDomain === undefined ? [] : ["Google Workspace"]),
  ];
  const waiting = secretsWaiting(account);
  return (
    <>
      <SetupSection
        description="As someone at Grasp gave it. Every deploy sets it on core."
        title="How its people sign in"
      >
        {signIn === null ? (
          <Quiet>Not given yet.</Quiet>
        ) : (
          <Facts
            rows={[
              { label: "With", value: providers.join(", ") },
              { label: "Email domains", value: signIn.domains.join(", ") },
              { label: "First admins", value: signIn.admins.join(", ") },
              {
                label: "Last changed",
                value:
                  account?.configChangedAt === null ||
                  account?.configChangedAt === undefined
                    ? "Not since it was set up"
                    : dayOf(account.configChangedAt),
              },
              ...(setup.signInOverridden
                ? [
                    {
                      label: "On deploy",
                      value: "A setting of its own replaces this",
                    },
                  ]
                : []),
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
          <SignInChange
            clientId={clientId}
            overridden={setup.signInOverridden}
            refresh={refresh}
            signIn={signIn}
          />
        )}
      </SetupSection>
      {client === null ? null : (
        <SetupSection
          description="A change to its settings reaches it with a deploy."
          title="Applying its settings"
        >
          <ApplySettings
            active={client.status === "active"}
            clientId={clientId}
            configPending={setup.configPending}
            pinned={client.pinnedReleaseId}
            refresh={refresh}
          />
        </SetupSection>
      )}
      <SetupSection
        description="Derived for this company alone, never stored. New ones reach it with its next deploy; the old ones keep working a while after."
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
      </SetupSection>
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
      <SetupSection
        description="What needs someone at Grasp about it, such as its Teams bot's secret running out, is posted to the staff alerts' channel with a link here."
        title="Staff alerts"
      >
        <TestAlert clientId={clientId} />
      </SetupSection>
    </>
  );
};

/** How often the Setup is read again while setting it up moves on by itself. */
const followMs = 5000;

/** Phases that move on without the page: its operation works on its own. */
const working: ReadonlySet<ProvisioningView["phase"]> = new Set([
  "provisioning",
]);

/**
 * Reads the Setup again every few seconds while setting the company up
 * moves on by itself: its run, or its operation in a hosting destination.
 */
const useFollow = (
  setup: ClientSetup,
  hosting: ClientHostingView | null,
  refresh: Refresh
) => {
  const following =
    hosting !== null && placedOf(hosting)
      ? hosting.going
      : working.has(setup.provisioning.phase);
  useEffect(() => {
    const timer = following
      ? setInterval(() => {
          void refresh();
        }, followMs)
      : undefined;
    return () => {
      clearInterval(timer);
    };
  }, [following, refresh]);
};

/**
 * The company's own Grasp, tab by tab: how it stands, its deploys, its
 * account, its releases and its settings. `view` is what its core
 * answered, worked out, for the checklist; null when it didn't answer
 * (being set up, or not reachable), when the rest still shows.
 */
export const OrgSetup = ({
  clientId,
  setup,
  tab,
  view,
  quotaPolicy,
  modelSpend,
  ai,
  releases,
  hosting,
}: {
  clientId: string;
  setup: ClientSetup;
  tab: SetupTab;
  view: AdminView | null;
  /** Its quota policy, read live and not awaited; null when it couldn't be read. */
  quotaPolicy: Promise<ClientQuotaPolicy | null>;
  /** Its spend this month as its core's ledger counts it, read live and not awaited; null when unknown. */
  modelSpend: Promise<ModelSpendReport | null>;
  /** Its AI, its core read live and not awaited; null when it couldn't be read. */
  ai: Promise<ClientModelTransport | null>;
  /** Every imported release, newest first. */
  releases: readonly { id: string; notes: string }[];
  hosting: ClientHostingView | null;
}) => {
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
            ai={ai}
            clientId={clientId}
            hosting={hosting}
            needs={needs}
            modelSpend={modelSpend}
            quotaPolicy={quotaPolicy}
            refresh={refresh}
            releases={releases}
            setup={setup}
            view={view}
          />
        </div>
      </TabsContent>
      <TabsContent value="history">
        <div className="flex flex-col gap-6 pt-4">
          <Done setup={setup} />
        </div>
      </TabsContent>
      <TabsContent value="resources">
        <div className="flex flex-col gap-6 pt-4">
          <Resources clientId={clientId} setup={setup} />
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
          <Settings clientId={clientId} refresh={refresh} setup={setup} />
        </div>
      </TabsContent>
    </Tabs>
  );
};
