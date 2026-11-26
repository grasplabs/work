import { ADMIN_PHASES, phaseOf } from "@grasp-os/shared/admin/admin-health";
import type { AdminPhase } from "@grasp-os/shared/admin/admin-health";
import { portfolioOf } from "@grasp-os/shared/admin/admin-view";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Link } from "@grasp-os/ui/components/link";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import { ArrowRightIcon, Icon, PlusIcon } from "@grasp-os/ui/lib/icons";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import {
  createFileRoute,
  Link as RouterLink,
  useNavigate,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { WithAdmins } from "../admin/admins.tsx";
import { PageLoading } from "../admin/failure.tsx";
import { AdminPage } from "../admin/page.tsx";
import { Panel, PanelNote } from "../admin/panel.tsx";
import { KnowledgeDots, StageBar } from "../admin/parts.tsx";
import { ReadinessBanner } from "../admin/readiness-parts.tsx";
import { fetchReadiness } from "../admin/readiness.ts";
import {
  organizationsOf,
  rolloutNeedLine,
  rolloutNeeds,
  unreadWords,
} from "../admin/views.ts";
import type { Organization } from "../admin/views.ts";
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
} from "../admin/words.ts";
import type { ClientAdmin } from "../clients/admin.ts";

interface AdminSearch {
  /** Only the organizations in this phase. */
  phase?: AdminPhase;
}

/** At most this many of what needs Grasp on the overview: the rest is on each organization's own. */
const todayItems = 8;

/** From this many organizations on, they can be shown by phase: fewer are all in sight at once. */
const phaseTabsFrom = 9;

/** How many dots say how much is known. */
const knowledgeDots = 20;

const styles = stylex.create({
  // A cell's lines, one under the other.
  lines: { display: "flex", flexDirection: "column", gap: space["1"] },
  // A line that waits on Grasp, or a contract that ends: in the warning's colour.
  warning: { color: colors.warning },
  muted: { color: colors.mutedForeground },
  figures: { fontVariantNumeric: "tabular-nums" },
  together: { display: "flex", flexDirection: "column", gap: space["2"] },
});

/** A cell with nothing to say: a dash, never a made-up number. */
const Nothing = () => (
  <Text as="span" color="muted" size="sm">
    –
  </Text>
);

/** A small line under a cell's words, quiet or, when it waits on Grasp, in the warning's colour. */
const Note = ({
  warn = false,
  children,
}: {
  warn?: boolean;
  children: ReactNode;
}) => (
  <Text as="span" color="muted" size="xs">
    <span {...stylex.props(warn && styles.warning)}>{children}</span>
  </Text>
);

/** An organization's name: the link the whole row opens by. */
const NameLink = ({ id, name }: { id: string; name: string }) => (
  <Link asChild variant="plain">
    <RouterLink
      data-row-target
      params={{ clientId: id }}
      to="/organizations/$clientId"
    >
      {name}
    </RouterLink>
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
  const stage = stageWords[view.stage];
  const lines = stageLines(view);
  const line = lines[view.stage];
  const opens = lines.open;
  // Enough is known and the go is still to give: that is Grasp's to do.
  const waits = view.knowledge.ready && view.knowledge.opened === null;
  let contractLine = "";
  if (contract.status === "signed" && !view.unknown.contract) {
    contractLine = contract.ending
      ? `Ends on ${formatDate(contract.until)}`
      : `${euros(contract.fee)} a month`;
  }
  return (
    <TableRow interactive>
      <TableCell rowHeader wrap>
        <NameLink id={id} name={name} />
      </TableCell>
      <TableCell hideBelow="sm" wrap>
        <span {...stylex.props(styles.lines)}>
          <span>{stage}</span>
          <StageBar label={`${stage}: ${line}`} stages={view.stages} />
          <Note>{line}</Note>
        </span>
      </TableCell>
      <TableCell hideBelow="md" wrap>
        <span {...stylex.props(styles.lines)}>
          <KnowledgeDots
            count={knowledgeDots}
            knowledge={view.knowledge}
            label={opens}
          />
          <span aria-hidden>
            <Note warn={waits}>{opens}</Note>
          </span>
        </span>
      </TableCell>
      <TableCell hideBelow="md" wrap>
        <span {...stylex.props(styles.lines)}>
          <span>{contractName(view)}</span>
          <Note warn={contract.ending}>{contractLine}</Note>
        </span>
      </TableCell>
      <TableCell align="end" hideBelow="md">
        {view.usage.thisMonth.spend > 0 ? (
          euro(view.usage.thisMonth.spend)
        ) : (
          <Nothing />
        )}
      </TableCell>
      <TableCell align="end">
        {view.needs.length > 0 ? (
          <span {...stylex.props(styles.warning, styles.figures)}>
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
    <TableRow interactive>
      <TableCell rowHeader wrap>
        <NameLink id={admin.client.id} name={admin.client.name} />
      </TableCell>
      <TableCell hideBelow="sm" wrap>
        <span {...stylex.props(styles.lines)}>
          <span>{why}</span>
          {last === null ? null : <Note>{last}</Note>}
        </span>
      </TableCell>
      <TableCell hideBelow="md">
        <Nothing />
      </TableCell>
      <TableCell hideBelow="md">
        <Nothing />
      </TableCell>
      <TableCell align="end" hideBelow="md">
        <Nothing />
      </TableCell>
      <TableCell align="end">
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

/** What the contract column says: unknown until the company's core holds one. */
const contractName = ({ contract, unknown }: AdminView): string => {
  if (unknown.contract) {
    return "Not known yet";
  }
  return contract.status === "signed"
    ? contract.plan
    : contractWords[contract.status];
};

/** A sum over the organizations it is known for: a dash where it is known for none, and from how many where not for all. */
const knownSum = (value: string, counted: number, of: number) => ({
  value: counted === 0 ? "—" : value,
  from: counted > 0 && counted < of ? `, from ${counted} of ${of}` : "",
});

/** What every answered organization adds up to. */
const Portfolio = ({
  views,
  unread,
}: {
  views: AdminView[];
  unread: number;
}) => {
  const portfolio = portfolioOf(views);
  const fees = knownSum(
    euros(portfolio.fees),
    portfolio.counted.fees,
    portfolio.orgs
  );
  const freed = knownSum(
    whole(portfolio.freed),
    portfolio.counted.value,
    portfolio.orgs
  );
  return (
    <section
      aria-label="Every organization together"
      {...stylex.props(styles.together)}
    >
      {/* A figure's note (what it counts in, how far it is known) is its
          `change`, the words beside it: Damsko's Stat has no line under
          its value. */}
      <StatGroup aria-label="Every organization together">
        <Stat
          label={portfolio.orgs === 1 ? "Organization" : "Organizations"}
          value={String(portfolio.orgs)}
        />
        <Stat label="Ready for Grasp’s go" value={String(portfolio.ready)} />
        <Stat label="Open, in the platform" value={String(portfolio.open)} />
        <Stat
          change={`a month, before VAT${fees.from}`}
          label="Under contract"
          value={fees.value}
        />
        <Stat label="AI this month" value={euro(portfolio.spend)} />
        <Stat
          change={
            portfolio.counted.value === 0
              ? "not known yet"
              : `worth ${euros(portfolio.value)} a month${freed.from}`
          }
          label="Hours a week freed"
          value={freed.value}
        />
      </StatGroup>
      {unread > 0 ? (
        <Text color="muted" size="sm">
          {`Counted from the ${views.length} that answered now: ${unread} didn’t, and ${unread === 1 ? "isn’t" : "aren’t"} in these numbers.`}
        </Text>
      ) : null}
    </section>
  );
};

/**
 * What needs Grasp at one organization, the most pressing first: what its
 * own platform needs (`rolloutNeeds`, acted on from its Setup), whether
 * its core answered or not, then what its core's view says.
 */
const needsAt = ({ admin, view }: Organization) => {
  const { id, name } = admin.client;
  return [
    ...rolloutNeeds(admin.client).map((need) => ({
      id,
      name,
      text: rolloutNeedLine(need),
      setup: true,
    })),
    ...(view === null
      ? []
      : view.needs.map((need) => ({
          id,
          name,
          text: needLine(need, view),
          setup: false,
        }))),
  ];
};

/** What needs Grasp today, at every organization: the most pressing at each first. */
const NeedsToday = ({ organizations }: { organizations: Organization[] }) => {
  const each = organizations.map(needsAt);
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
    <Panel
      description="At every organization, the most pressing first."
      title="Needs Grasp today"
    >
      <CardContent flush>
        <ItemGroup separated>
          {waiting
            .slice(0, todayItems)
            .map(({ id, name, text, setup }, index) => (
              <Item
                // The same need can stand twice at one organization, for two teams.
                key={`${id}-${index}`}
                size="sm"
              >
                <ItemMedia>
                  <Badge dot variant="warning" />
                </ItemMedia>
                <ItemContent>
                  <ItemDescription>{name}</ItemDescription>
                  <ItemTitle>{text}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button asChild size="sm" variant="outline">
                    {setup ? (
                      <RouterLink
                        aria-label={`Open at ${name}: ${text}`}
                        params={{ clientId: id }}
                        to="/organizations/$clientId/setup"
                      >
                        Open
                        <Icon icon={ArrowRightIcon} />
                      </RouterLink>
                    ) : (
                      <RouterLink
                        aria-label={`Open at ${name}: ${text}`}
                        params={{ clientId: id }}
                        to="/organizations/$clientId"
                      >
                        Open
                        <Icon icon={ArrowRightIcon} />
                      </RouterLink>
                    )}
                  </Button>
                </ItemActions>
              </Item>
            ))}
        </ItemGroup>
      </CardContent>
      {more > 0 ? (
        <PanelNote>
          {more === 1
            ? "1 more, on the organization’s own overview."
            : `${more} more, on the organizations’ own overviews.`}
        </PanelNote>
      ) : null}
    </Panel>
  );
};

/**
 * Grasp's own side, ported from the prototype's admin root
 * (grasplabs/prototype `routes/admin/index.tsx`): what every organization
 * adds up to, what needs Grasp today, then each organization with where it
 * stands and how many things need Grasp there, all as the admin's model
 * works it out of what its core answered (src/admin/views.ts). One whose
 * core didn't answer is listed with why. Beside each, its own platform as
 * its account shows it now, read once the page shows, as the admin's
 * list of clients read it (src/clients/grid.ts).
 *
 * Left out, as the admin has no source for them yet: exporting them,
 * and the prototype's line on which are past the milestone and still
 * closed.
 */
const Organizations = ({ admins }: { admins: readonly ClientAdmin[] }) => {
  const navigate = useNavigate();
  const { phase } = Route.useSearch();
  const organizations = organizationsOf(admins);
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
    <>
      <Portfolio unread={organizations.length - views.length} views={views} />
      <NeedsToday organizations={organizations} />
      {/* The organizations by phase: where each is, from the first conversation until it works in Grasp. */}
      {organizations.length < phaseTabsFrom && phase === undefined ? null : (
        <Tabs
          onValueChange={(value) => {
            const chosen = ADMIN_PHASES.find((each) => each === value);
            void navigate({
              to: "/",
              search: chosen === undefined ? {} : { phase: chosen },
            });
          }}
          value={phase ?? "all"}
        >
          <TabsList aria-label="Show organizations" variant="line">
            <TabsTrigger value="all">
              {"All "}
              <Text as="span" color="muted" size="sm">
                {organizations.length}
              </Text>
            </TabsTrigger>
            {ADMIN_PHASES.map((each) => (
              <TabsTrigger key={each} value={each}>
                {`${phaseWords[each]} `}
                <Text as="span" color="muted" size="sm">
                  {views.filter((view) => phaseOf(view) === each).length}
                </Text>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      {/* Then the organizations themselves: what needs Grasp at one is on its own page, a click away. */}
      <Panel title="Every organization">
        <CardContent flush>
          <Table aria-label="Every organization">
            <TableHeader>
              <TableRow>
                <TableHead>Organization</TableHead>
                <TableHead hideBelow="sm">Where it stands</TableHead>
                <TableHead hideBelow="md">Known</TableHead>
                <TableHead hideBelow="md">Contract</TableHead>
                <TableHead align="end" hideBelow="md">
                  AI this month
                </TableHead>
                <TableHead align="end">Needs Grasp</TableHead>
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
        </CardContent>
      </Panel>
    </>
  );
};

/** The overview's title, its action and readiness at once; the organizations once their cores answered. */
const Overview = () => {
  const readiness = Route.useLoaderData();
  return (
    <AdminPage
      action={
        <Button asChild>
          <RouterLink to="/new-organization">
            <Icon icon={PlusIcon} />
            New organization
          </RouterLink>
        </Button>
      }
      description="Every company with Grasp, from its first conversation on. Only Grasp sees this: a company sees numbers per team, never names."
      overview
      title="Organizations"
    >
      <ReadinessBanner readiness={readiness} />
      <WithAdmins>{(admins) => <Organizations admins={admins} />}</WithAdmins>
    </AdminPage>
  );
};

/** The admin's overview: every organization together. */
export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): AdminSearch => {
    const phase = ADMIN_PHASES.find((each) => each === search.phase);
    return phase === undefined ? {} : { phase };
  },
  loader: async () => await fetchReadiness(),
  component: Overview,
  pendingComponent: PageLoading,
});
