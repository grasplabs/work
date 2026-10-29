/**
 * Integrations to build, ported from the prototype (grasplabs/prototype
 * `routes/admin/integrations.tsx`, `components/admin/integration-build.tsx`):
 * the apps the companies asked Grasp to add, as Composio's catalog doesn't
 * have them, for every organization at once. Grasp builds each into the
 * platform itself, once, for every company that asked.
 *
 * Each app is a row, as each company's core says it asked for it
 * (`askedApps`), at the build's first step: asked for, waiting on a person
 * at Grasp. A row opens the build (`?app=`): who asked, and its steps with
 * the four where a person at Grasp decides. What the agent found out about
 * the app (its docs, how it signs in, each action), its work and the
 * buttons that move a build on come with the admin's record of builds
 * (GRA-689). Until Grasp's build agent exists (`buildAgentAvailable`),
 * nothing here starts one: the page says so, and how to add an app by
 * hand instead. A build that stopped for a person can be closed here.
 */
import { BUILD_STAGES } from "@grasp-os/shared/admin/admin-integrations";
import type { BuildStep } from "@grasp-os/shared/admin/admin-integrations";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { cn } from "@grasp-os/ui/lib/utils";
import {
  getRouteApi,
  Link,
  rootRouteId,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { HammerIcon } from "lucide-react";
import type { ReactNode } from "react";

import { buildAgentAvailable } from "../builds/builds.ts";
import type { BuildErrorCode, StoppedBuild } from "../builds/builds.ts";
import { closeBuildFn, restartBuildFn } from "../builds/functions.ts";
import { thenRefresh, useAction } from "../use-action.ts";
import { askedApps } from "./integrations-asked.ts";
import type { AskedApp } from "./integrations-asked.ts";
import { AdminPage } from "./page.tsx";
import { Panel } from "./panel.tsx";
import { formatDate, formatList, plural } from "./words.ts";

/** Every organization, as the admin's layout read them. */
const adminRoute = getRouteApi(rootRouteId);

/** Each step of a build in a word or two, as the list and the build show it. */
export const stepWords: Record<BuildStep, string> = {
  requested: "Asked for",
  researching: "Researching",
  plan: "Plan ready",
  credentials: "Credentials",
  writing: "Writing",
  testing: "Testing",
  selfReview: "Self-review",
  review: "In review",
  merged: "Merged",
  rollout: "Rolling out",
  live: "Live",
};

/** What happens at each step, for the steps in the build. */
const stepLines: Record<BuildStep, string> = {
  requested: "A company asked for it, and Composio does not have it.",
  researching:
    "Grasp’s agent reads the app’s docs and writes a plan: the actions, what each may reach, and how it signs in.",
  plan: "A person at Grasp approves the plan, or sends it back.",
  credentials:
    "A person at Grasp registers Grasp with the app and puts the keys in the admin. The agent never sees them.",
  writing:
    "The agent writes the connection and its tests, on a branch of its own.",
  testing: "The checks and tests run, against a stand-in for the app.",
  selfReview:
    "A second agent checks the work against Grasp’s rules for connections.",
  review: "Nick or Jakob reviews the pull request and merges it.",
  merged: "It goes into the next release by itself.",
  rollout:
    "The release reaches the companies ring by ring, as a person at Grasp approves each.",
  live: "Every company that asked can connect it, like any other app.",
};

/** The steps where a person at Grasp decides: the plan, the credentials, the review, the rollout. */
const personSteps: ReadonlySet<BuildStep> = new Set([
  "plan",
  "credentials",
  "review",
  "rollout",
]);

/**
 * Where an asked app stands: at the first step. With no build agent yet,
 * it waits for someone at Grasp to write its connector by hand.
 */
const waitingLine = buildAgentAvailable
  ? "Waiting for Grasp to start it"
  : "Waiting for Grasp to build it by hand";

/** Why nothing here starts a build yet, and what to do instead. */
export const noAgentLine =
  "Grasp’s build agent doesn’t exist yet, so nothing here starts a build. To add an app now, write its connector by hand in packages/connectors/<app> with @grasp-os/connector-kit and open a pull request: once merged, it reaches every company with the next release.";

/** The build's steps as a short bar: the first waits on Grasp, the rest are still to come. */
const BuildBar = ({ label }: { label: string }) => (
  <span className="flex w-28 gap-0.5">
    <span className="sr-only">{label}</span>
    {BUILD_STAGES.map((step, index) => (
      <span
        aria-hidden
        className={cn(
          "h-1 flex-1 rounded-full",
          index === 0 ? "bg-status-attention" : "bg-border"
        )}
        key={step}
      />
    ))}
  </span>
);

/** The companies that asked for an app, by name. */
const askedByOf = (app: AskedApp): string =>
  formatList(app.asks.map((ask) => ask.orgName));

/**
 * One app on one row: its name, who asked for it, and where its build
 * stands. The row opens the build; where it waits on a person at Grasp,
 * the line says so in orange.
 */
const BuildRow = ({ app }: { app: AskedApp }) => {
  const stage = stepWords.requested;
  const orgs = askedByOf(app);
  return (
    <TableRow className="relative">
      <TableCell className="whitespace-normal" variant="card">
        <Link
          aria-label={`Open ${app.name}`}
          className="focus-visible:ring-ring/50 flex w-full min-w-0 flex-col rounded-sm outline-none after:absolute after:inset-0 focus-visible:ring-3"
          search={{ app: app.key }}
          to="/integrations"
        >
          <span className="font-medium hover:underline">{app.name}</span>
          {/* Where there is no room for columns of their own, who asked and where it stands go under the name. */}
          <span className="text-muted-foreground text-xs @xl:hidden">
            {orgs}
          </span>
          <span className="text-status-attention mt-1 text-xs @lg:hidden">
            {`${stage}: ${waitingLine}`}
          </span>
        </Link>
      </TableCell>
      <TableCell
        className="hidden whitespace-normal @xl:table-cell"
        variant="card"
      >
        <span className="flex flex-col">
          <span>{orgs}</span>
          <span className="text-muted-foreground text-xs">
            {`Asked on ${formatDate(app.asks[0]?.on ?? "")}`}
          </span>
        </span>
      </TableCell>
      <TableCell
        className="hidden w-60 whitespace-normal @lg:table-cell"
        variant="card"
      >
        <span className="flex flex-col gap-1.5">
          <span>{stage}</span>
          <BuildBar label={`${stage}: ${waitingLine}`} />
          <span className="text-status-attention text-xs">{waitingLine}</span>
        </span>
      </TableCell>
    </TableRow>
  );
};

/** Every app asked for, one row each, the one most asked for first. */
const BuildTable = ({ apps }: { apps: readonly AskedApp[] }) => (
  <section className="bg-card @container overflow-hidden rounded-xl border">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead variant="card">App</TableHead>
          <TableHead className="hidden @xl:table-cell" variant="card">
            Asked by
          </TableHead>
          <TableHead className="hidden w-60 @lg:table-cell" variant="card">
            Where it stands
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apps.map((app) => (
          <BuildRow app={app} key={app.key} />
        ))}
      </TableBody>
    </Table>
  </section>
);

/** A part of the build's sheet under a line, with its title. */
const Part = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-3 border-b p-4">
    <h3 className="font-medium">{title}</h3>
    {children}
  </section>
);

/** Where one step of the build stands: the first now, waiting on Grasp; the rest later. */
const StepMark = ({ now }: { now: boolean }) => (
  <span
    aria-hidden
    className={cn(
      "mt-0.5 flex size-4 flex-none items-center justify-center rounded-full",
      now ? "border-status-attention border-2" : "border-border border"
    )}
  />
);

/** The build's steps, in order, with where a person at Grasp decides. */
const BuildSteps = () => (
  <ol className="flex flex-col">
    {BUILD_STAGES.map((step, index) => {
      const now = index === 0;
      return (
        <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3" key={step}>
          <span className="flex flex-col items-center">
            <StepMark now={now} />
            {index < BUILD_STAGES.length - 1 ? (
              <span aria-hidden className="bg-border my-1 w-px flex-1" />
            ) : null}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5 pb-3">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={cn(now ? "font-medium" : "text-muted-foreground")}
              >
                {stepWords[step]}
              </span>
              {personSteps.has(step) ? (
                <Badge variant="outline">A person</Badge>
              ) : null}
            </span>
            {now ? (
              <span className="text-status-attention text-xs">
                {stepLines[step]}
              </span>
            ) : null}
          </span>
        </li>
      );
    })}
  </ol>
);

/** One app asked for, whole: who asked for it, and the build's steps. */
const BuildDetail = ({ app }: { app: AskedApp }) => (
  <>
    <SheetHeader>
      <SheetTitle>{app.name}</SheetTitle>
      <SheetDescription>
        <span className="text-status-attention">{waitingLine}</span>
      </SheetDescription>
    </SheetHeader>
    <Part title="Who asked">
      <ul className="flex flex-col gap-3">
        {app.asks.map((ask) => (
          <li className="flex flex-col gap-0.5" key={ask.org}>
            <Link
              className="w-fit font-medium underline-offset-4 hover:underline"
              params={{ clientId: ask.org }}
              to="/organizations/$clientId/integrations"
            >
              {ask.orgName}
            </Link>
            <span className="text-muted-foreground text-xs">
              {`Asked on ${formatDate(ask.on)}`}
            </span>
          </li>
        ))}
      </ul>
    </Part>
    <Part title="The build">
      <BuildSteps />
    </Part>
  </>
);

/** The build open in its sheet, when `open` names an app asked for. */
const BuildSheet = ({
  apps,
  open,
}: {
  apps: readonly AskedApp[];
  open: string | undefined;
}) => {
  const navigate = useNavigate({ from: "/integrations" });
  const shown = apps.find((app) => app.key === open);
  return (
    <Sheet
      onOpenChange={(next) => {
        if (!next) {
          void navigate({ search: {}, replace: true });
        }
      }}
      open={shown !== undefined}
    >
      <SheetContent className="overflow-y-auto" size="wide">
        {shown === undefined ? null : <BuildDetail app={shown} />}
      </SheetContent>
    </Sheet>
  );
};

/** That no build agent exists yet, and how an app is added meanwhile. */
const NoAgent = () => (
  <Panel description={noAgentLine} title="Build it isn’t available yet">
    {null}
  </Panel>
);

/** Each refusal of restarting or closing a build, worded for staff. */
const buildRefusals: Record<BuildErrorCode, string> = {
  invalid_app: "That isn’t an app to build.",
  unknown_build: "That build is gone already. The page is read again.",
  note_required: "Say what the next plan should change.",
  wrong_stage:
    "That build isn’t stopped any more: someone acted on it first. The page is read again.",
  invalid_plan: "That plan can’t be approved.",
  wrong_branch: "That pull request isn’t on the build’s own branch.",
  wrong_pull_request: "That merge isn’t of the build’s pull request.",
  agent_unavailable: noAgentLine,
};

/** Why a build stopped, from its code, in a sentence. */
const stoppedWords = ({ stoppedAt, reason }: StoppedBuild): string => {
  if (reason?.endsWith("_timed_out") === true) {
    return `It waited too long at ${stoppedAt ?? "a stage"} and stopped.`;
  }
  if (reason === "restart_not_started") {
    return "A restart didn't start its run: restart it again, or close it.";
  }
  if (reason === "too_many_plans") {
    return "No plan was approved in five rounds.";
  }
  return `It stopped at ${stoppedAt ?? "a stage"}${reason === null ? "" : ` (${reason})`}.`;
};

/**
 * One build that stopped for a person: why, and what can be done. Close
 * takes it away, so its app shows as asked for again; Restart starts it
 * from the beginning, once the build agent exists.
 */
const StoppedRow = ({ build }: { build: StoppedBuild }) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(buildRefusals);
  const act = (fn: typeof closeBuildFn) => {
    void run(
      async () =>
        await thenRefresh(
          async () => await fn({ data: { app: build.app } }),
          async () => {
            await router.invalidate({ sync: true });
          }
        )
    );
  };
  return (
    <li className="flex flex-col gap-2 border-t px-5 py-3">
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">{build.name}</span>
          <span className="text-muted-foreground text-xs">
            {stoppedWords(build)}
          </span>
        </span>
        <span className="flex flex-none gap-2">
          <Button
            disabled={busy || !buildAgentAvailable}
            onClick={() => {
              act(restartBuildFn);
            }}
            size="sm"
            variant="outline"
          >
            Restart
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              act(closeBuildFn);
            }}
            size="sm"
            variant="outline"
          >
            Close
          </Button>
        </span>
      </span>
      {failure === null ? null : (
        <p className="text-destructive" role="alert">
          {failure}
        </p>
      )}
    </li>
  );
};

/** Every build that stopped for a person; nothing while none did. */
const StoppedBuilds = ({ stopped }: { stopped: readonly StoppedBuild[] }) =>
  stopped.length === 0 ? null : (
    <Panel
      description={
        buildAgentAvailable
          ? "Each waits for someone at Grasp: restart it, or close it so its app shows as asked for again."
          : "Each waits for someone at Grasp. Close it so its app shows as asked for again; Restart comes with the build agent."
      }
      title="Builds that stopped"
    >
      <ul className="flex flex-col">
        {stopped.map((build) => (
          <StoppedRow build={build} key={build.app} />
        ))}
      </ul>
    </Panel>
  );

/** Where the table of builds goes, while nothing is asked for. */
const NothingToBuild = () => (
  <section className="bg-card rounded-xl border">
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HammerIcon />
        </EmptyMedia>
        <EmptyTitle>Nothing to build yet</EmptyTitle>
        <EmptyDescription>
          When a company asks for an app Composio does not have, it shows here,
          with who asked for it and where its build stands.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  </section>
);

/** How a build goes, in plain words, and where people at Grasp stay in it. */
const buildSteps = [
  "A company’s workflow needs an app Composio does not have. It lands here once, however many companies ask for it.",
  "Build it starts Grasp’s agent on a branch of its own. It reads the app’s docs and writes a plan, which a person at Grasp approves.",
  "A person registers Grasp with the app and puts the keys in the admin. The agent works against a stand-in for the app: it never sees a company’s data or production secrets.",
  "The agent writes the connection and its tests, runs them, has a second agent review the work, and opens a pull request. Nick or Jakob reviews it and merges it.",
  "The merge goes into the next release, which reaches the companies ring by ring as a person approves each. Then every company that asked connects the app like any other.",
] as const;

/**
 * How it is built, as the prototype says it. Its note that the platform
 * first needs sign-in with OAuth2 and with an API key is left out: connect
 * has both now, so every new app is one package and one record.
 */
const HowItIsBuilt = () => (
  <Panel
    description="Grasp’s agent does the writing; people at Grasp approve the plan, add the keys, review the code and approve the rollout."
    title="How it is built"
  >
    <ol className="flex flex-col">
      {buildSteps.map((step, index) => (
        <li className="flex gap-3 border-t px-5 py-3" key={step}>
          <span className="text-muted-foreground w-4 flex-none tabular-nums">
            {index + 1}
          </span>
          <span className="min-w-0 text-pretty">{step}</span>
        </li>
      ))}
    </ol>
  </Panel>
);

/** How many apps wait on a person at Grasp, beside the title. */
const WaitingBadge = ({ count }: { count: number }) => (
  <Badge variant="outline">
    <span aria-hidden className="bg-status-attention size-1.5 rounded-full" />
    {`${count} ${plural(count, "waits", "wait")} on Grasp`}
  </Badge>
);

/** The page: what it is for, the apps asked for, the one open, and how one is built. */
export const IntegrationsToBuild = ({
  open,
  stopped,
}: {
  open: string | undefined;
  stopped: readonly StoppedBuild[];
}) => {
  // The asked apps alone, until the page shows the admin's record of
  // builds (GRA-689): then it reads `integrationsToBuild`
  // (./integrations-asked.ts) with the builds, as the admin's MCP does, so
  // the two say the same.
  const apps = askedApps(adminRoute.useLoaderData().admins);
  return (
    <AdminPage
      action={
        apps.length > 0 ? <WaitingBadge count={apps.length} /> : undefined
      }
      description="Apps the companies’ workflows need that Composio does not have. Grasp builds each into the platform itself, once, for every company that asked."
      title="Integrations to build"
    >
      <div className="flex flex-col gap-6 text-sm">
        {buildAgentAvailable ? null : <NoAgent />}
        <StoppedBuilds stopped={stopped} />
        {apps.length > 0 ? <BuildTable apps={apps} /> : <NothingToBuild />}
        <HowItIsBuilt />
      </div>
      <BuildSheet apps={apps} open={open} />
    </AdminPage>
  );
};
