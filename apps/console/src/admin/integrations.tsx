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
 * buttons that move a build on come with the console's record of builds
 * (GRA-689): until then nothing here starts one.
 */
import { BUILD_STAGES } from "@grasp-os/shared/admin/admin-integrations";
import type { BuildStep } from "@grasp-os/shared/admin/admin-integrations";
import { Badge } from "@grasp-os/ui/components/badge";
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
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { HammerIcon } from "lucide-react";
import type { ReactNode } from "react";

import { askedApps } from "./integrations-asked.ts";
import type { AskedApp } from "./integrations-asked.ts";
import { AdminPage } from "./page.tsx";
import { Panel } from "./panel.tsx";
import { formatDate, formatList, plural } from "./words.ts";

/** Every organization, as the admin's layout read them. */
const adminRoute = getRouteApi("/admin");

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
    "A person at Grasp registers Grasp with the app and puts the keys in the console. The agent never sees them.",
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

/** Where an asked app stands: at the first step, waiting on Grasp to start it. */
const waitingLine = "Waiting for Grasp to start it";

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
          to="/admin/integrations"
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
              to="/admin/organizations/$clientId/integrations"
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
  const navigate = useNavigate({ from: "/admin/integrations" });
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
  "A person registers Grasp with the app and puts the keys in the console. The agent works against a stand-in for the app: it never sees a company’s data or production secrets.",
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
export const IntegrationsToBuild = ({ open }: { open: string | undefined }) => {
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
        {apps.length > 0 ? <BuildTable apps={apps} /> : <NothingToBuild />}
        <HowItIsBuilt />
      </div>
      <BuildSheet apps={apps} open={open} />
    </AdminPage>
  );
};
