/**
 * An organization's Setup: the company's own Grasp as the console runs
 * it, from the contract to every day after, ported from the prototype
 * (grasplabs/prototype `components/admin/org-setup.tsx`,
 * `platform-parts.tsx` and `platform-words.ts`). Unlike the other
 * sections it reads the console's own records (src/clients/setup.ts):
 * how it stands and what needs a look, how it runs from its address to
 * its data, every deploy step by step, what runs in its Cloudflare
 * account, the releases it gets, and how its people sign in.
 *
 * Read only: what someone at Grasp does to a platform (resume a run,
 * confirm Workers Paid, a ring, a pin, applying settings) is done on the
 * client's own console page, which every place that needs it links to.
 * What the console doesn't read yet (the requests and errors of every
 * day, what each resource holds) says so rather than show a number.
 */
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
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
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleDashedIcon,
  CircleIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  PauseIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { z } from "zod";

import type { ClientSetup, SetupDeploy } from "../clients/setup.ts";
import type { DeployStep } from "../deploy/deploy.ts";
import type { ProvisioningView } from "../provision/queries.ts";
import { formatTime } from "../releases/format.ts";
import type { ClientDriftState } from "../rollout/drift.ts";
import { fetchDrift } from "../rollout/functions.ts";
import type { DriftCheck } from "../rollout/functions.ts";
import { useOrganization } from "./organization.tsx";
import { sectionTo } from "./sections.ts";
import type { OrgSection } from "./sections.ts";
import { formatDate } from "./words.ts";

/** The section's tabs, in order: how it stands first. */
export const setupTabs = [
  "status",
  "deploys",
  "resources",
  "releases",
  "settings",
] as const;
export type SetupTab = (typeof setupTabs)[number];

const tabWords: Record<SetupTab, string> = {
  status: "Status",
  deploys: "Deploys",
  resources: "Resources",
  releases: "Releases",
  settings: "Settings",
};

/** A day as the section says it: "2 Sep 2026". */
const dayOf = (at: Date): string => formatDate(at.toISOString().slice(0, 10));

/** A version's id, short. */
const shortVersion = (id: string): string => id.slice(0, 8);

const dashboard = (accountId: string): string =>
  `https://dash.cloudflare.com/${accountId}`;

// The words of the console's own things, as the admin says them.

/** A deploy's steps, in order, as src/deploy/deploy.ts runs them. */
const deploySteps = [
  "resources",
  "migrations",
  "workers",
  "smoke",
  "router",
] as const satisfies readonly DeployStep[];

/** Where each step is in a deploy. */
const deployStepAt = new Map<string, number>(
  deploySteps.map((step, index) => [step, index])
);

const stepWords: Record<DeployStep, { label: string; about: string }> = {
  resources: {
    label: "Resources",
    about:
      "Its databases, its files and its AI Gateway, found or made, all in the EU.",
  },
  migrations: {
    label: "Migrations",
    about: "The database migrations of the release, once each.",
  },
  workers: {
    label: "Workers",
    about: "Core and connect uploaded with their secrets, and made live.",
  },
  smoke: {
    label: "Smoke check",
    about: "Core answers as the new version, through the router.",
  },
  router: {
    label: "Address",
    about: "Its address in the router’s map, so its people reach it.",
  },
};

/** Setting a company up, in order: its account, its record, Workers Paid, the first deploy, active. */
const provisionSteps = [
  "account",
  "record",
  "paid",
  "deploy",
  "active",
] as const;
type ProvisionStep = (typeof provisionSteps)[number];

const provisionWords: Record<ProvisionStep, string> = {
  account: "Its own Cloudflare account, in the EU",
  record: "Recorded in the console",
  paid: "Workers Paid, confirmed by someone at Grasp",
  deploy: "The first deploy",
  active: "Active",
};

const kindWords: Record<SetupDeploy["kind"], string> = {
  release: "Release",
  secrets: "New secrets",
  settings: "Settings",
  settings_and_secrets: "Settings and secrets",
};

const deployStatusWords: Record<SetupDeploy["status"], string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  superseded: "Replaced",
};

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
  in_sync: "In sync: it runs what the console made live",
  drifted: "Runs another version than the console made live",
  split: "Runs two versions at once",
  off_pin: "Runs another release than it is pinned to",
  unknown: "Not known: nothing is live yet, or its account didn’t answer",
};

/** A ring as the admin says it: the first one by name. */
const ringWords = (ring: number): string =>
  ring === 0 ? "Ring 0, first" : `Ring ${ring}`;

/** An error code as the section says it: the code alone, as the console keeps it. */
const ErrorCode = ({ code }: { code: string }) => (
  <span className="font-mono text-xs">{code}</span>
);

// The section's parts.

/** A titled part of the section, with what can be done beside its title. */
const SetupSection = ({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section
    aria-label={title}
    className="bg-card overflow-hidden rounded-xl border text-sm"
  >
    {/* Where there is no room beside it, what can be done goes under the title. */}
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-5 py-4">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <h2 className="font-medium">{title}</h2>
        {description === undefined ? null : (
          <p className="text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
    {children}
  </section>
);

/** A line in a section, for what it has none of yet. */
const Quiet = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground border-t px-5 py-3">{children}</p>
);

/** A few facts as rows: what it is on the left, the fact on the right. */
const Facts = ({
  rows,
}: {
  rows: { label: string; value: ReactNode; attention?: boolean }[];
}) => (
  <dl className="flex flex-col">
    {rows.map((row) => (
      <div
        className="flex items-baseline justify-between gap-4 border-t px-5 py-3"
        key={row.label}
      >
        <dt className="text-muted-foreground flex-none">{row.label}</dt>
        <dd
          className={cn(
            "min-w-0 text-right wrap-break-word",
            row.attention === true && "text-status-attention"
          )}
        >
          {row.value}
        </dd>
      </div>
    ))}
  </dl>
);

/** The way over to the client's own page in the console, where what is done to it is done. */
const ConsoleLink = ({
  clientId,
  children = "Open in the console",
}: {
  clientId: string;
  children?: ReactNode;
}) => (
  <Button
    nativeButton={false}
    render={<Link params={{ clientId }} to="/clients/$clientId" />}
    size="sm"
    variant="ghost"
  >
    {children}
  </Button>
);

/** The way over to something outside the console, in a new tab. */
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

type StepState = "done" | "running" | "waiting" | "failed" | "todo";

const stepSaid: Record<StepState, string> = {
  done: "done",
  running: "running",
  waiting: "waits on someone at Grasp",
  failed: "failed",
  todo: "to come",
};

/** Each state's mark: its colours, and its sign. */
const marks: Record<StepState, { className: string; sign: ReactNode }> = {
  done: {
    className: "bg-status-agreed text-background border-transparent",
    sign: <CheckIcon className="size-3.5" />,
  },
  failed: {
    className: "bg-status-attention text-background border-transparent",
    sign: <XIcon className="size-3.5" />,
  },
  running: {
    className: "border-foreground",
    sign: <LoaderCircleIcon className="size-3.5 motion-safe:animate-spin" />,
  },
  waiting: {
    className: "border-status-attention text-status-attention",
    sign: <PauseIcon className="size-3" />,
  },
  todo: { className: "bg-card", sign: null },
};

const StepMark = ({ state }: { state: StepState }) => (
  <span
    className={cn(
      "flex size-6 flex-none items-center justify-center rounded-full border",
      marks[state].className
    )}
  >
    {marks[state].sign}
  </span>
);

/**
 * Steps in order, each with how far it is: across on a wide page, one
 * under the other on a phone. What each is now is read out after it.
 */
const Steps = ({
  label,
  steps,
}: {
  label: string;
  steps: { id: string; label: string; about?: string; state: StepState }[];
}) => (
  <div className="@container">
    <ol
      aria-label={label}
      className="grid gap-3 @2xl:auto-cols-fr @2xl:grid-flow-col @2xl:gap-0"
    >
      {steps.map((step, index) => (
        <li className="flex gap-3 @2xl:flex-col @2xl:gap-2" key={step.id}>
          <span className="flex items-center @2xl:pr-2">
            <StepMark state={step.state} />
            {index < steps.length - 1 ? (
              <span
                aria-hidden
                className={cn(
                  "ml-2 hidden h-px flex-1 @2xl:block",
                  step.state === "done" ? "bg-status-agreed" : "bg-border"
                )}
              />
            ) : null}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5 @2xl:pr-4">
            <span
              className={cn(
                step.state === "todo" && "text-muted-foreground",
                step.state === "failed" && "text-status-attention"
              )}
            >
              {step.label}
              <span className="sr-only">{`: ${stepSaid[step.state]}`}</span>
            </span>
            {step.about === undefined ? null : (
              <span className="text-muted-foreground text-xs">
                {step.about}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  </div>
);

// What the console's records say, worked out.

/** How far setting the company up got: every step done once it is active. */
const provisionStepsOf = (
  view: ProvisioningView
): { step: ProvisionStep; state: StepState }[] => {
  if (view.client !== null && view.client.status !== "provisioning") {
    return provisionSteps.map((step) => ({ step, state: "done" }));
  }
  let at: ProvisionStep = "deploy";
  if (view.client === null) {
    at = "account";
  } else if (!view.workersPaidConfirmed) {
    at = "paid";
  }
  let now: StepState = "running";
  if (view.phase === "failed") {
    now = "failed";
  } else if (view.phase === "workers_paid") {
    now = "waiting";
  }
  const reached = provisionSteps.indexOf(at);
  return provisionSteps.map((step, index) => {
    if (index < reached) {
      return { step, state: "done" };
    }
    return { step, state: index === reached ? now : "todo" };
  });
};

/** How far a deploy got, step by step. */
const deployStepsOf = (
  deploy: SetupDeploy
): { step: DeployStep; state: StepState }[] => {
  const reached = deployStepAt.get(deploy.step ?? "") ?? -1;
  return deploySteps.map((step, index) => {
    if (deploy.status === "done" || index <= reached) {
      return { step, state: "done" };
    }
    if (index > reached + 1) {
      return { step, state: "todo" };
    }
    if (deploy.status === "failed") {
      return { step, state: "failed" };
    }
    return { step, state: deploy.status === "running" ? "running" : "todo" };
  });
};

/** What about a company's platform needs someone at Grasp, the most pressing first. */
type PlatformNeed =
  | { kind: "failed"; deploy: SetupDeploy }
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
  const { provisioning, deploys, rollout, behind } = setup;
  const needs: PlatformNeed[] = [];
  const [last] = deploys;
  if (last?.status === "failed") {
    needs.push({ kind: "failed", deploy: last });
  }
  if (
    provisioning.phase === "failed" ||
    (provisioning.phase === "workers_paid" &&
      !provisioning.workersPaidConfirmed)
  ) {
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
  if (need.kind === "failed") {
    return (
      <>
        {`The last deploy failed (${kindWords[need.deploy.kind]}): `}
        <ErrorCode code={need.deploy.error ?? "no code"} />
      </>
    );
  }
  if (need.kind === "provisioning") {
    const { view } = need;
    if (view.phase === "workers_paid") {
      return `Setting it up waits on someone at Grasp: ${provisionWords.paid}.`;
    }
    return view.stopped === null ? (
      "Setting it up stopped, and waits to be resumed."
    ) : (
      <>
        {`Setting it up stopped at its ${view.stopped.step} step: `}
        <ErrorCode code={view.stopped.error} />
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

/** Its address, how it stands, its release and ring, and the ways over to the console and Cloudflare. */
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
        <ConsoleLink clientId={clientId} />
        {client === null ? null : (
          <OutLink
            href={dashboard(client.accountId)}
            label="Open in Cloudflare"
          />
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

const Status = ({
  clientId,
  setup,
  needs,
  view,
  contractRead,
}: {
  clientId: string;
  setup: ClientSetup;
  needs: PlatformNeed[];
  view: AdminView;
  contractRead: boolean;
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
              {need.kind === "rollout" ? (
                <Button
                  nativeButton={false}
                  render={
                    <Link
                      params={{ rolloutId: need.rollout.id }}
                      to="/rollouts/$rolloutId"
                    />
                  }
                  size="sm"
                  variant="ghost"
                >
                  The rollout
                </Button>
              ) : (
                <ConsoleLink clientId={clientId} />
              )}
            </li>
          ))}
        </ul>
      </SetupSection>
    ) : null}
    <SetupSection
      description="Its requests, what ended in an error, and what it costs, day by day."
      title="Its platform in numbers"
    >
      <Quiet>
        The console doesn’t keep these day by day yet. Its errors of the last
        day and its cost this month are read live on{" "}
        <Link
          className="hover:text-foreground underline underline-offset-4"
          to="/"
        >
          the console’s list of clients
        </Link>
        .
      </Quiet>
    </SetupSection>
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
    <Checklist
      clientId={clientId}
      contractRead={contractRead}
      setup={setup}
      view={view}
    />
  </>
);

/** What a ring change records besides. */
const ringSchema = z.object({ ring: z.number() });

/** What staff did by hand, in a sentence. */
const eventWords = ({
  action,
  target,
  detail,
}: ClientSetup["done"][number]): string => {
  switch (action) {
    case "client.provision_start": {
      return "Started setting it up.";
    }
    case "client.provision_retry": {
      return "Resumed setting it up.";
    }
    case "client.workers_paid": {
      return "Confirmed Workers Paid.";
    }
    case "client.ring": {
      const ring = ringSchema.safeParse(JSON.parse(detail ?? "null")).data
        ?.ring;
      return ring === undefined
        ? "Moved it to another ring."
        : `Moved it to ${ringWords(ring).toLowerCase()}.`;
    }
    case "client.pin": {
      return `Pinned it to ${target ?? "a release"}.`;
    }
    case "client.unpin": {
      return "Let it follow the rollouts again.";
    }
    case "client.rotate_secrets": {
      return "Rotated its secrets.";
    }
    case "client.sign_in": {
      return "Changed how its people sign in.";
    }
    case "client.apply_settings": {
      return "Applied its settings.";
    }
    default: {
      return action;
    }
  }
};

const Deploys = ({
  clientId,
  setup,
}: {
  clientId: string;
  setup: ClientSetup;
}) => {
  const { provisioning, deploys, done } = setup;
  const [latest] = deploys;
  const settingUp = provisioning.client?.status !== "active";
  return (
    <>
      {settingUp ? (
        <SetupSection
          action={<ConsoleLink clientId={clientId} />}
          description="One run in the console makes its account, records it, waits for Workers Paid, deploys the release of its ring and marks it active. Every step can run again without making anything twice."
          title="Setting it up"
        >
          <div className="border-t px-5 py-4">
            <Steps
              label="Setting it up"
              steps={provisionStepsOf(provisioning).map(({ step, state }) => ({
                id: step,
                label: provisionWords[step],
                state,
              }))}
            />
          </div>
        </SetupSection>
      ) : null}
      {latest === undefined ? (
        <SetupSection title="Its deploys">
          <Quiet>No deploy yet.</Quiet>
        </SetupSection>
      ) : (
        <SetupSection
          action={
            latest.status === "failed" ? (
              <ConsoleLink clientId={clientId} />
            ) : undefined
          }
          description={`${kindWords[latest.kind]} · ${latest.releaseId} · ${formatTime(latest.createdAt)} UTC · ${latest.startedBy}`}
          title="The last deploy"
        >
          <div className="flex flex-col gap-3 border-t px-5 py-4">
            <Steps
              label="The last deploy"
              steps={deployStepsOf(latest).map(({ step, state }) => ({
                id: step,
                ...stepWords[step],
                state,
              }))}
            />
            {latest.status === "failed" ? (
              <p className="text-status-attention">
                {"It stopped: "}
                <ErrorCode code={latest.error ?? "no code"} />
              </p>
            ) : null}
          </div>
        </SetupSection>
      )}
      {deploys.length > 0 ? (
        <SetupSection
          description={`${setup.moreDeploys ? `The latest ${deploys.length}, newest first: older ones aren’t listed.` : "The newest first."} A rollout deploys a release; someone at Grasp deploys new settings or secrets.`}
          title="Recent deploys"
        >
          <div className="@container border-t">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead variant="card">When (UTC)</TableHead>
                  <TableHead variant="card">What</TableHead>
                  <TableHead className="hidden @xl:table-cell" variant="card">
                    Release
                  </TableHead>
                  <TableHead className="hidden @2xl:table-cell" variant="card">
                    By
                  </TableHead>
                  <TableHead className="text-right" variant="card">
                    Result
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deploys.map((deploy) => (
                  <TableRow key={deploy.id}>
                    <TableCell variant="card">
                      <span className="tabular-nums">
                        {formatTime(deploy.createdAt)}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal" variant="card">
                      {kindWords[deploy.kind]}
                    </TableCell>
                    <TableCell className="hidden @xl:table-cell" variant="card">
                      <span className="font-mono text-xs">
                        {deploy.releaseId}
                      </span>
                    </TableCell>
                    <TableCell
                      className="hidden whitespace-normal @2xl:table-cell"
                      variant="card"
                    >
                      <span className="text-muted-foreground">
                        {deploy.startedBy}
                      </span>
                    </TableCell>
                    <TableCell className="text-right" variant="card">
                      <span
                        className={cn(
                          deploy.status === "failed" && "text-status-attention",
                          deploy.status === "superseded" &&
                            "text-muted-foreground"
                        )}
                      >
                        {deployStatusWords[deploy.status]}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SetupSection>
      ) : null}
      {done.length > 0 ? (
        <SetupSection
          description="What someone at Grasp did to its platform by hand, as the console’s audit log keeps it."
          title="Done here"
        >
          <ul className="flex flex-col">
            {done.map((event) => (
              <li
                className="flex items-baseline justify-between gap-4 border-t px-5 py-3"
                key={event.id}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{eventWords(event)}</span>
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
    </>
  );
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
        <ul className="text-muted-foreground flex flex-col gap-1 text-xs">
          {drift.workers.map((worker) => (
            <li key={worker.worker}>
              <span className="font-mono">{worker.scriptName}</span>
              {": "}
              {worker.live === null
                ? "not known"
                : worker.live
                    .map(
                      ({ version_id: version, percentage }) =>
                        `${shortVersion(version)} at ${percentage}%`
                    )
                    .join(", ")}
            </li>
          ))}
        </ul>
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
  const { provisioning, account, workers, resources } = setup;
  const { client } = provisioning;
  if (client === null) {
    return (
      <SetupSection
        description="Made when it is set up, in the EU."
        title="Its Cloudflare account"
      >
        <Quiet>Nothing yet.</Quiet>
      </SetupSection>
    );
  }
  const core = workers.find(({ worker }) => worker === "core");
  const subdomain = account?.workersSubdomain ?? null;
  return (
    <>
      <SetupSection
        description="Its own, in the EU: Grasp deploys into it, and the company’s data stays in it."
        title="Its Cloudflare account"
      >
        <Facts
          rows={[
            { label: "Account", value: client.name },
            {
              label: "Account id",
              value: (
                <span className="font-mono text-xs">{client.accountId}</span>
              ),
            },
            {
              label: "Address",
              value: provisioning.hostname ?? "No domain set in the console",
            },
            {
              label: "Before the address",
              value:
                subdomain === null || core === undefined ? (
                  "–"
                ) : (
                  <span className="font-mono text-xs">{`${core.scriptName}.${subdomain}.workers.dev`}</span>
                ),
            },
          ]}
        />
      </SetupSection>
      <SetupSection
        description="What the console made live, and what Cloudflare says runs."
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
    to="/rollouts/$rolloutId"
  >
    {`${rollout.releaseId ?? "New secrets"}: ${targetWords[rollout.target].toLowerCase()}`}
  </Link>
);

const Releases = ({
  clientId,
  setup,
}: {
  clientId: string;
  setup: ClientSetup;
}) => {
  const { provisioning, releases, rollout } = setup;
  const { client } = provisioning;
  const runs = releaseOf(setup);
  const pinned = client?.pinnedReleaseId ?? null;
  return (
    <>
      <SetupSection
        action={
          <ConsoleLink clientId={clientId}>
            Change it in the console
          </ConsoleLink>
        }
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
      </SetupSection>
      <SetupSection
        action={
          <Button
            nativeButton={false}
            render={<Link to="/releases" />}
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
                    to="/releases/$releaseId"
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

const Settings = ({
  clientId,
  setup,
}: {
  clientId: string;
  setup: ClientSetup;
}) => {
  const { signIn, account } = setup;
  const providers = [
    ...(signIn?.entraTenantId === undefined ? [] : ["Microsoft Entra ID"]),
    ...(signIn?.googleHostedDomain === undefined ? [] : ["Google Workspace"]),
  ];
  const waiting = secretsWaiting(account);
  return (
    <>
      <SetupSection
        action={
          <ConsoleLink clientId={clientId}>
            Change it in the console
          </ConsoleLink>
        }
        description="As someone at Grasp gave it when it was set up. Every deploy sets it on core."
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
      </SetupSection>
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
      </SetupSection>
    </>
  );
};

/**
 * The company's own Grasp, tab by tab: how it stands, its deploys, its
 * account, its releases and its settings.
 */
export const OrgSetup = ({
  setup,
  tab,
}: {
  setup: ClientSetup;
  tab: SetupTab;
}) => {
  const { admin, view } = useOrganization();
  const navigate = useNavigate();
  const clientId = admin.client.id;
  const needs = needsOf(setup);
  return (
    <Tabs
      onValueChange={(value: SetupTab) => {
        void navigate({
          to: "/admin/organizations/$clientId/setup",
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
            clientId={clientId}
            contractRead={!view.unknown.contract}
            needs={needs}
            setup={setup}
            view={view}
          />
        </div>
      </TabsContent>
      <TabsContent value="deploys">
        <div className="flex flex-col gap-6 pt-4">
          <Deploys clientId={clientId} setup={setup} />
        </div>
      </TabsContent>
      <TabsContent value="resources">
        <div className="flex flex-col gap-6 pt-4">
          <Resources clientId={clientId} setup={setup} />
        </div>
      </TabsContent>
      <TabsContent value="releases">
        <div className="flex flex-col gap-6 pt-4">
          <Releases clientId={clientId} setup={setup} />
        </div>
      </TabsContent>
      <TabsContent value="settings">
        <div className="flex flex-col gap-6 pt-4">
          <Settings clientId={clientId} setup={setup} />
        </div>
      </TabsContent>
    </Tabs>
  );
};
