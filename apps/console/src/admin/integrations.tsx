/**
 * Integrations to build, ported from the prototype (grasplabs/prototype
 * `routes/admin/integrations.tsx`, `components/admin/integration-build.tsx`):
 * the apps the companies asked Grasp to add, as Composio's catalog doesn't
 * have them, for every organization at once. Grasp builds each into the
 * platform itself, once, for every company that asked.
 *
 * Each app is a row, as each company's core says it asked for it
 * (`askedApps`), met by its key with the build the console records
 * (src/builds/builds.ts), and where that build stands (`integrationRows`):
 * what waits on a person at Grasp first. A row opens the build (`?app=`,
 * src/admin/integration-build.tsx), with the one action that fits.
 */
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Sheet, SheetContent } from "@grasp-os/ui/components/sheet";
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
import { ExternalLinkIcon, HammerIcon } from "lucide-react";

import {
  BuildBar,
  BuildDetail,
  BuildIt,
  pullRequestUrl,
} from "./integration-build.tsx";
import { integrationRows, needsGrasp, stepOf } from "./integration-builds.ts";
import type { IntegrationRow } from "./integration-builds.ts";
import { stepWords, waitingLine } from "./integration-words.ts";
import { askedApps } from "./integrations-asked.ts";
import { AdminPage } from "./page.tsx";
import { Panel } from "./panel.tsx";
import { formatDate, formatList, plural } from "./words.ts";

/** Every organization, and every build, as the admin's layout read them. */
const adminRoute = getRouteApi("/admin");

/** The companies that asked for an app, by name. */
const askedByOf = (row: IntegrationRow): string =>
  row.asks.length === 0
    ? "No company asks for it now"
    : formatList(row.asks.map((ask) => ask.orgName));

/** The one thing to do on a row, where it is one: beside the row where there is room, under the name where there is not. */
const RowAction = ({ row }: { row: IntegrationRow }) => {
  const { build } = row;
  if (build === null) {
    return <BuildIt row={row} />;
  }
  if (build.stage === "in_review" && build.pullRequest !== null) {
    return (
      <Button
        className="relative"
        nativeButton={false}
        render={
          <a
            aria-label={`Open the pull request of ${row.name}, in a new tab`}
            href={pullRequestUrl(build.pullRequest)}
            rel="noopener noreferrer"
            target="_blank"
          />
        }
        size="sm"
        variant="outline"
      >
        Pull request
        <ExternalLinkIcon data-icon="inline-end" />
      </Button>
    );
  }
  if (build.stage === "plan_ready" || build.stage === "credentials") {
    return (
      <Button
        className="relative"
        nativeButton={false}
        render={<Link search={{ app: row.key }} to="/admin/integrations" />}
        size="sm"
        variant="outline"
      >
        {build.stage === "plan_ready" ? "Review the plan" : "Add credentials"}
      </Button>
    );
  }
  return null;
};

/** Whether a row has a thing to do on it. */
const hasAction = ({ build }: IntegrationRow): boolean =>
  build === null ||
  build.stage === "plan_ready" ||
  build.stage === "credentials" ||
  (build.stage === "in_review" && build.pullRequest !== null);

/**
 * One app on one row: its name, who asked for it, where its build stands,
 * and the one thing to do there. The row opens the build; where it waits
 * on a person at Grasp, the line says so in orange.
 */
const BuildRow = ({ row }: { row: IntegrationRow }) => {
  const stage = stepWords[stepOf(row.build)];
  const line = waitingLine(row);
  const waits = needsGrasp(row);
  const orgs = askedByOf(row);
  const action = hasAction(row);
  return (
    <TableRow className="relative" data-app={row.key}>
      <TableCell className="whitespace-normal" variant="card">
        <Link
          aria-label={`Open ${row.name}`}
          className="focus-visible:ring-ring/50 flex w-full min-w-0 flex-col rounded-sm outline-none after:absolute after:inset-0 focus-visible:ring-3"
          search={{ app: row.key }}
          to="/admin/integrations"
        >
          <span className="font-medium hover:underline">{row.name}</span>
          {/* Where there is no room for columns of their own, who asked and where it stands go under the name. */}
          <span className="text-muted-foreground text-xs @xl:hidden">
            {orgs}
          </span>
          <span
            className={cn(
              "mt-1 text-xs @lg:hidden",
              waits ? "text-status-attention" : "text-muted-foreground"
            )}
          >
            {`${stage}: ${line}`}
          </span>
        </Link>
        {action ? (
          <div className="mt-2 @md:hidden">
            <RowAction row={row} />
          </div>
        ) : null}
      </TableCell>
      <TableCell
        className="hidden whitespace-normal @xl:table-cell"
        variant="card"
      >
        <span className="flex flex-col">
          <span>{orgs}</span>
          {row.asks[0] === undefined ? null : (
            <span className="text-muted-foreground text-xs">
              {`Asked on ${formatDate(row.asks[0].on)}`}
            </span>
          )}
        </span>
      </TableCell>
      <TableCell
        className="hidden w-60 whitespace-normal @lg:table-cell"
        variant="card"
      >
        <span className="flex flex-col gap-1.5">
          <span>{stage}</span>
          <BuildBar label={`${stage}: ${line}`} row={row} />
          <span
            className={cn(
              "text-xs",
              waits ? "text-status-attention" : "text-muted-foreground"
            )}
          >
            {line}
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden text-right @md:table-cell" variant="card">
        {action ? <RowAction row={row} /> : null}
      </TableCell>
    </TableRow>
  );
};

/** Every app asked for, and every build, one row each: what waits on Grasp first. */
const BuildTable = ({ rows }: { rows: readonly IntegrationRow[] }) => (
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
          <TableHead className="hidden @md:table-cell" variant="card">
            <span className="sr-only">What to do</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <BuildRow key={row.key} row={row} />
        ))}
      </TableBody>
    </Table>
  </section>
);

/** The build open in its sheet, when `open` names an app asked for or built. */
const BuildSheet = ({
  rows,
  open,
}: {
  rows: readonly IntegrationRow[];
  open: string | undefined;
}) => {
  const navigate = useNavigate({ from: "/admin/integrations" });
  const shown = rows.find((row) => row.key === open);
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
        {shown === undefined ? null : (
          <BuildDetail key={shown.key} row={shown} />
        )}
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
  const { admins, builds } = adminRoute.useLoaderData();
  const rows = integrationRows(askedApps(admins), builds);
  const waiting = rows.filter(needsGrasp).length;
  return (
    <AdminPage
      action={waiting > 0 ? <WaitingBadge count={waiting} /> : undefined}
      description="Apps the companies’ workflows need that Composio does not have. Grasp builds each into the platform itself, once, for every company that asked."
      title="Integrations to build"
    >
      <div className="flex flex-col gap-6 text-sm">
        {rows.length > 0 ? <BuildTable rows={rows} /> : <NothingToBuild />}
        <HowItIsBuilt />
      </div>
      <BuildSheet open={open} rows={rows} />
    </AdminPage>
  );
};
