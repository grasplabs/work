import {
  ADMIN_PHASES,
  healthOf,
  phaseOf,
} from "@grasp-os/shared/admin/admin-health";
import type {
  AdminPhase,
  HealthLevel,
} from "@grasp-os/shared/admin/admin-health";
import { portfolioOf } from "@grasp-os/shared/admin/admin-view";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import { cn } from "@grasp-os/ui/lib/utils";
import {
  createFileRoute,
  getRouteApi,
  Link,
  useNavigate,
} from "@tanstack/react-router";
import { ArrowRightIcon, PlusIcon } from "lucide-react";

import { AdminPage } from "../../admin/page.tsx";
import { KnowledgeDots, StageBar, Tile } from "../../admin/parts.tsx";
import { organizationsOf, unreadWords } from "../../admin/views.ts";
import type { Organization } from "../../admin/views.ts";
import {
  contractWords,
  euro,
  euros,
  formatDate,
  needLine,
  phaseWords,
  stageLines,
  stageWords,
  whole,
} from "../../admin/words.ts";
import type { ClientAdmin } from "../../clients/admin.ts";

/** Every organization, as the admin's layout read them. */
const adminRoute = getRouteApi("/admin");

interface AdminSearch {
  /** Only the organizations in this phase. */
  phase?: AdminPhase;
}

/** At most this many of what needs Grasp on the overview: the rest is on each organization's own. */
const todayItems = 8;

/** How many dots say how much is known. */
const knowledgeDots = 20;

const healthMark: Record<HealthLevel, string> = {
  none: "bg-border",
  good: "bg-status-agreed",
  watch: "bg-status-attention/40",
  attention: "bg-status-attention",
};

/** A cell with nothing to say: a dash, never a made-up number. */
const Nothing = () => <span className="text-muted-foreground">–</span>;

/** An organization's name, linking to its own page, with whatever goes under it. */
const NameLink = ({
  id,
  name,
  children,
}: {
  id: string;
  name: string;
  children?: React.ReactNode;
}) => (
  <Link
    className="focus-visible:ring-ring/50 flex flex-col rounded-sm outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-3"
    params={{ clientId: id }}
    to="/admin/organizations/$clientId"
  >
    <span className="font-medium">{name}</span>
    {children}
  </Link>
);

/** One organization whose core answered: everything the model worked out of it. */
const AnsweredRow = ({
  view,
  id,
  name,
}: {
  view: AdminView;
  id: string;
  name: string;
}) => {
  const { contract } = view;
  const health = healthOf(view);
  const needing = health.filter(
    (signal) => signal.level === "attention"
  ).length;
  const stage = stageWords[view.stage];
  const lines = stageLines(view);
  const line = lines[view.stage];
  const opens = lines.open;
  // Enough is known and the go is still to give: that is Grasp's to do.
  const waits = view.knowledge.ready && view.knowledge.opened === null;
  let contractLine = "";
  if (contract.status === "signed") {
    contractLine = contract.ending
      ? `Ends on ${formatDate(contract.until)}`
      : `${euros(contract.fee)} a month`;
  }
  return (
    <TableRow className="relative">
      <TableCell className="whitespace-normal" variant="card">
        <NameLink id={id} name={name}>
          {/* Where there is no room for a column of its own, where it stands goes under the name. */}
          <span className="text-muted-foreground mt-1 text-xs @xl:hidden">
            {`${stage}: ${line}`}
          </span>
          <span
            className={cn(
              "text-xs @3xl:hidden",
              waits ? "text-status-attention" : "text-muted-foreground"
            )}
          >
            {opens}
          </span>
        </NameLink>
      </TableCell>
      <TableCell
        className="hidden whitespace-normal @xl:table-cell"
        variant="card"
      >
        <span className="flex flex-col gap-1.5">
          <span>{stage}</span>
          <StageBar label={`${stage}: ${line}`} stages={view.stages} />
          <span className="text-muted-foreground text-xs">{line}</span>
        </span>
      </TableCell>
      <TableCell
        className="hidden whitespace-normal @3xl:table-cell"
        variant="card"
      >
        <span className="flex flex-col gap-1.5">
          <KnowledgeDots
            count={knowledgeDots}
            knowledge={view.knowledge}
            label={opens}
          />
          <span
            aria-hidden
            className={cn(
              "text-xs",
              waits ? "text-status-attention" : "text-muted-foreground"
            )}
          >
            {opens}
          </span>
        </span>
      </TableCell>
      <TableCell
        className="hidden whitespace-normal @5xl:table-cell"
        variant="card"
      >
        <span className="flex flex-col">
          <span>
            {contract.status === "signed"
              ? contract.plan
              : contractWords[contract.status]}
          </span>
          <span
            className={cn(
              "text-xs",
              contract.ending
                ? "text-status-attention"
                : "text-muted-foreground"
            )}
          >
            {contractLine}
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden @4xl:table-cell" variant="card">
        <span className="flex items-center gap-1">
          {health.map((signal) => (
            <span
              aria-hidden
              className={cn("size-2 rounded-full", healthMark[signal.level])}
              key={signal.area}
            />
          ))}
          <span className="sr-only">
            {`Needs Grasp in ${needing} of ${health.length} areas`}
          </span>
        </span>
      </TableCell>
      <TableCell className="hidden text-right @6xl:table-cell" variant="card">
        {view.usage.thisMonth.spend > 0 ? (
          <span className="tabular-nums">
            {euro(view.usage.thisMonth.spend)}
          </span>
        ) : (
          <Nothing />
        )}
      </TableCell>
      <TableCell className="text-right" variant="card">
        {view.needs.length > 0 ? (
          <span className="text-status-attention tabular-nums">
            {view.needs.length}
          </span>
        ) : (
          <Nothing />
        )}
      </TableCell>
    </TableRow>
  );
};

/**
 * One organization whose core didn't answer: its name and why, and when
 * it last answered, with nothing in the columns the model would fill.
 */
const UnreadRow = ({
  admin,
}: {
  admin: Extract<ClientAdmin, { state: "unreachable" }>;
}) => {
  const words = unreadWords(admin);
  const why = `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  const last =
    admin.lastAnsweredAt === null
      ? null
      : `Last answered on ${formatDate(admin.lastAnsweredAt)}`;
  return (
    <TableRow className="relative">
      <TableCell className="whitespace-normal" variant="card">
        <NameLink id={admin.client.id} name={admin.client.name}>
          <span className="text-muted-foreground mt-1 text-xs @xl:hidden">
            {last === null ? why : `${why}. ${last}`}
          </span>
        </NameLink>
      </TableCell>
      <TableCell
        className="hidden whitespace-normal @xl:table-cell"
        variant="card"
      >
        <span className="flex flex-col gap-1.5">
          <span>{why}</span>
          {last === null ? null : (
            <span className="text-muted-foreground text-xs">{last}</span>
          )}
        </span>
      </TableCell>
      <TableCell className="hidden @3xl:table-cell" variant="card">
        <Nothing />
      </TableCell>
      <TableCell className="hidden @5xl:table-cell" variant="card">
        <Nothing />
      </TableCell>
      <TableCell className="hidden @4xl:table-cell" variant="card">
        <Nothing />
      </TableCell>
      <TableCell className="hidden text-right @6xl:table-cell" variant="card">
        <Nothing />
      </TableCell>
      <TableCell className="text-right" variant="card">
        <Nothing />
      </TableCell>
    </TableRow>
  );
};

const OrganizationRow = ({ organization }: { organization: Organization }) => {
  const { admin, view } = organization;
  if (admin.state === "unreachable") {
    return <UnreadRow admin={admin} />;
  }
  return view === null ? null : (
    <AnsweredRow id={admin.client.id} name={admin.client.name} view={view} />
  );
};

/** What every answered organization adds up to. */
const Portfolio = ({
  views,
  unread,
}: {
  views: AdminView[];
  unread: number;
}) => {
  const portfolio = portfolioOf(views);
  return (
    <section
      aria-label="Every organization together"
      className="flex flex-col gap-2"
    >
      <div className="overflow-hidden rounded-xl border text-sm">
        {/* Two abreast on a phone too: one a row made the numbers a screen long before the list began. */}
        <div className="bg-border grid grid-cols-2 gap-px lg:grid-cols-3 xl:grid-cols-6">
          <Tile
            label={portfolio.orgs === 1 ? "organization" : "organizations"}
            value={portfolio.orgs}
          />
          <Tile label="ready for Grasp’s go" value={portfolio.ready} />
          <Tile label="open, and in the platform" value={portfolio.open} />
          <Tile
            label="a month under contract, before VAT"
            value={euros(portfolio.fees)}
          />
          <Tile label="of AI used this month" value={euro(portfolio.spend)} />
          <Tile
            label={`hours a week freed, worth ${euros(portfolio.value)} a month`}
            value={whole(portfolio.freed)}
          />
        </div>
      </div>
      {unread > 0 ? (
        <p className="text-muted-foreground text-sm">
          {`Counted from the ${views.length} that answered now: ${unread} didn’t, and ${unread === 1 ? "isn’t" : "aren’t"} in these numbers.`}
        </p>
      ) : null}
    </section>
  );
};

/** What needs Grasp today, at every answered organization: the most pressing at each first. */
const NeedsToday = ({ organizations }: { organizations: Organization[] }) => {
  const each = organizations.map(({ admin, view }) =>
    view === null
      ? []
      : view.needs.map((need) => ({
          id: admin.client.id,
          name: admin.client.name,
          text: needLine(need, view),
        }))
  );
  // Every organization's most pressing first, then each one's next: in
  // turn, so the first few can't fill the list before the rest are heard.
  const deepest = Math.max(0, ...each.map((needs) => needs.length));
  const waiting = Array.from({ length: deepest }, (_, rank) =>
    each.flatMap((needs) => needs.slice(rank, rank + 1))
  ).flat();
  if (waiting.length === 0) {
    return null;
  }
  const more = waiting.length - todayItems;
  return (
    <section className="bg-card overflow-hidden rounded-xl border text-sm">
      <div className="flex flex-col gap-0.5 px-5 py-4">
        <h2 className="font-medium">Needs Grasp today</h2>
        <p className="text-muted-foreground">
          At every organization, the most pressing first.
        </p>
      </div>
      <ul className="flex flex-col">
        {waiting.slice(0, todayItems).map(({ id, name, text }, index) => (
          <li
            className="flex items-center justify-between gap-4 border-t px-5 py-3"
            // The same need can stand twice at one organization, for two teams.
            key={`${id}-${index}`}
          >
            <span className="flex min-w-0 items-start gap-2.5">
              <span
                aria-hidden
                className="bg-status-attention mt-1.5 size-1.5 flex-none rounded-full"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-muted-foreground text-xs">{name}</span>
                <span>{text}</span>
              </span>
            </span>
            <Button
              aria-label={`Open at ${name}: ${text}`}
              nativeButton={false}
              render={
                <Link
                  params={{ clientId: id }}
                  to="/admin/organizations/$clientId"
                />
              }
              size="sm"
              variant="ghost"
            >
              Open
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <p className="text-muted-foreground border-t px-5 py-3">
          {more === 1
            ? "1 more, on the organization’s own overview."
            : `${more} more, on the organizations’ own overviews.`}
        </p>
      ) : null}
    </section>
  );
};

/**
 * Grasp's own side, ported from the prototype's admin root
 * (grasplabs/prototype `routes/admin/index.tsx`): what every organization
 * adds up to, what needs Grasp today, then each organization with where it
 * stands and how many things need Grasp there, all as the admin's model
 * works it out of what its core answered (src/admin/views.ts). One whose
 * core didn't answer is listed with why, and nothing else.
 *
 * Left out, as the console has no source for them yet: exporting them,
 * and the prototype's line on which are past the milestone and still
 * closed.
 */
const Overview = () => {
  const navigate = useNavigate();
  const { phase } = Route.useSearch();
  const organizations = organizationsOf(adminRoute.useLoaderData());
  const views = organizations.flatMap(({ view }) =>
    view === null ? [] : [view]
  );
  const shown =
    phase === undefined
      ? organizations
      : organizations.filter(
          ({ view }) => view !== null && phaseOf(view) === phase
        );
  return (
    <AdminPage
      action={
        <Button
          nativeButton={false}
          render={<Link to="/admin/new-organization" />}
        >
          <PlusIcon data-icon="inline-start" />
          New organization
        </Button>
      }
      description="Every company with Grasp, from its first conversation on. Only Grasp sees this: a company sees numbers per team, never names."
      overview
      title="Organizations"
    >
      <Portfolio unread={organizations.length - views.length} views={views} />
      <NeedsToday organizations={organizations} />
      {/* The organizations by phase: where each is, from the first conversation until it works in Grasp. */}
      <Tabs
        onValueChange={(value: string) => {
          const chosen = ADMIN_PHASES.find((each) => each === value);
          void navigate({
            to: "/admin",
            search: chosen === undefined ? {} : { phase: chosen },
          });
        }}
        value={phase ?? "all"}
      >
        <TabsList aria-label="Show organizations" variant="line">
          <TabsTrigger className="flex-none" value="all">
            All
            <span className="text-muted-foreground tabular-nums">
              {organizations.length}
            </span>
          </TabsTrigger>
          {ADMIN_PHASES.map((each) => (
            <TabsTrigger className="flex-none" key={each} value={each}>
              {phaseWords[each]}
              <span className="text-muted-foreground tabular-nums">
                {views.filter((view) => phaseOf(view) === each).length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {/* Then the organizations themselves: what needs Grasp at one is on its own page, a click away. */}
      <section className="bg-card @container overflow-hidden rounded-xl border text-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Organization</TableHead>
              <TableHead className="hidden @xl:table-cell" variant="card">
                Where it stands
              </TableHead>
              <TableHead className="hidden @3xl:table-cell" variant="card">
                Known
              </TableHead>
              <TableHead className="hidden @5xl:table-cell" variant="card">
                Contract
              </TableHead>
              <TableHead className="hidden @4xl:table-cell" variant="card">
                Health
              </TableHead>
              <TableHead
                className="hidden text-right @6xl:table-cell"
                variant="card"
              >
                AI this month
              </TableHead>
              <TableHead
                className="w-24 text-right whitespace-normal"
                variant="card"
              >
                Needs Grasp
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((organization) => (
              <OrganizationRow
                key={organization.admin.client.id}
                organization={organization}
              />
            ))}
          </TableBody>
        </Table>
      </section>
    </AdminPage>
  );
};

/** The admin's overview: every organization together. */
export const Route = createFileRoute("/admin/")({
  validateSearch: (search: Record<string, unknown>): AdminSearch => {
    const phase = ADMIN_PHASES.find((each) => each === search.phase);
    return phase === undefined ? {} : { phase };
  },
  component: Overview,
});
