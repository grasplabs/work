/**
 * An organization's Connectors, set on the page as Grasp Work sets one:
 * how its connections stand in four figures, the company's own
 * connections as a table (a card each on a phone), its people's own
 * counted by app, and what is still to connect as rows, or a line saying
 * there is nothing. Only what its core's snapshot sends
 * (`integrations`): names only where the company's connections name who
 * connected them, people's own as counts. A company that hasn't signed
 * in has nothing connected; a core on an older release, or one whose
 * connect didn't answer, sends none, and the page says so. The apps it
 * asked Grasp to add are the admin's own record, shown either way.
 */
import type {
  AdminAppAsked,
  AdminConnection,
  AdminIntegrations,
} from "@grasp-os/shared/admin-snapshot";
import { Badge } from "@grasp-os/ui/components/badge";
import type { BadgeVariant } from "@grasp-os/ui/components/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
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
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { CableIcon } from "@grasp-os/ui/lib/icons";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import {
  accessOf,
  appName,
  connectionWords,
  decidedByWords,
  needWords,
  neededApps,
} from "./connections.tsx";
import { appKey } from "./integrations-asked.ts";
import { useOrganization } from "./organization.tsx";
import { formatDate, formatList, plural } from "./words.ts";

const STACKED = "@media (width < 48rem)";

const styles = stylex.create({
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
  table: { display: { default: "block", [STACKED]: "none" } },
  cards: { display: { default: "none", [STACKED]: "block" } },
  app: { display: "grid", rowGap: space["1"] },
  quiet: {
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  badges: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
});

/** How a connection stands, as its Badge. */
const stateTones: Readonly<Record<AdminConnection["state"], BadgeVariant>> = {
  works: "success",
  again: "warning",
  stopped: "warning",
  unread: "default",
};

/** Who carries a connection's actions out, in a word. */
const throughWords: Readonly<Record<AdminConnection["source"], string>> = {
  composio: "Composio",
  native: "Grasp",
  http: "HTTP",
  connector: "Connector",
};

/** When it was connected, and by whom while they are a member. */
const connectedWords = (connection: AdminConnection): string => {
  const on = formatDate(connection.connectedAt);
  return connection.connectedBy === null
    ? on
    : `${on}, by ${connection.connectedBy}`;
};

/** What Grasp may do there, and whether its people see it. */
const accessWords = (connection: AdminConnection): string =>
  connection.hidden
    ? `${accessOf(connection)} · hidden from its people`
    : accessOf(connection);

const connectionKey = (connection: AdminConnection): string =>
  `${connection.source}:${connection.provider}:${connection.connectedAt}`;

const StateBadge = ({ connection }: { connection: AdminConnection }) => (
  <Badge dot variant={stateTones[connection.state]}>
    {connectionWords[connection.state]}
  </Badge>
);

/** Its connections in four figures: working, to sign in again, stopped, and people's own. */
const Figures = ({ integrations }: { integrations: AdminIntegrations }) => {
  const { connected, personal } = integrations;
  const works = connected.filter(({ state }) => state === "works").length;
  const again = connected.filter(({ state }) => state === "again").length;
  const stopped = connected.filter(({ state }) => state === "stopped").length;
  const people = personal.reduce((sum, app) => sum + app.people, 0);
  const peopleAgain = personal.reduce((sum, app) => sum + app.again, 0);
  return (
    <StatGroup aria-label="How its connections stand" columns={4}>
      <Stat
        change={`of ${connected.length} the company made`}
        label="Working"
        value={String(works)}
      />
      <Stat
        change={again > 0 ? "Someone there signs in" : ""}
        label="Need signing in again"
        value={String(again)}
        variant={again > 0 ? "warning" : "default"}
      />
      <Stat
        change={stopped > 0 ? "Stopped at Composio" : ""}
        label="Stopped"
        value={String(stopped)}
        variant={stopped > 0 ? "warning" : "default"}
      />
      <Stat
        change={
          peopleAgain > 0
            ? `${peopleAgain} need signing in again`
            : `${personal.length} ${plural(personal.length, "app", "apps")}`
        }
        label="People’s own"
        value={String(people)}
        variant={peopleAgain > 0 ? "warning" : "default"}
      />
    </StatGroup>
  );
};

/** The company's own connections: a table, and a card each on a phone. */
const Connected = ({
  connected,
}: {
  connected: readonly AdminConnection[];
}) => (
  <Part aria-labelledby="connected">
    <SectionHeader
      description="Where its people sign in, its documents, and the apps its work runs in."
      id="connected"
      size="sm"
      title="The company’s connections"
      variant="group"
    />
    {connected.length === 0 ? (
      <Empty align="start" size="sm">
        <EmptyHeader>
          <EmptyDescription>
            Nothing connected yet beyond its sign-in.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <>
        <div {...stylex.props(styles.table)}>
          <Table aria-labelledby="connected">
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead>Through</TableHead>
                <TableHead>Connected</TableHead>
                <TableHead align="end">State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connected.map((connection) => (
                <TableRow key={connectionKey(connection)}>
                  <TableCell rowHeader wrap>
                    <span {...stylex.props(styles.app)}>
                      <span>{appName(connection)}</span>
                      <span {...stylex.props(styles.quiet)}>
                        {accessWords(connection)}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>{throughWords[connection.source]}</TableCell>
                  <TableCell wrap>{connectedWords(connection)}</TableCell>
                  <TableCell align="end">
                    <StateBadge connection={connection} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div {...stylex.props(styles.cards)}>
          <ItemGroup aria-labelledby="connected" separated>
            {connected.map((connection) => (
              <Item key={connectionKey(connection)}>
                <ItemContent>
                  <ItemTitle>{appName(connection)}</ItemTitle>
                  <ItemDescription>
                    {`${accessWords(connection)} · ${throughWords[connection.source]} · ${connectedWords(connection)}`}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <StateBadge connection={connection} />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </div>
      </>
    )}
  </Part>
);

/** Its people's own connections, counted by app: never who. */
const PeoplesOwn = ({ integrations }: { integrations: AdminIntegrations }) =>
  integrations.personal.length === 0 ? null : (
    <Part aria-labelledby="own">
      <SectionHeader
        description="Counted by app: who connected stays in the company’s Grasp."
        id="own"
        size="sm"
        title="People’s own connections"
        variant="group"
      />
      <KeyValueList
        divided
        items={integrations.personal.map((app) => ({
          id: `${app.source}:${app.provider}`,
          label: appName(app),
          value: (
            <span {...stylex.props(styles.badges)}>
              {`${app.people} ${plural(app.people, "person", "people")}`}
              {app.again > 0 ? (
                <Badge variant="warning">{`${app.again} to sign in again`}</Badge>
              ) : null}
            </span>
          ),
        }))}
        orientation="horizontal"
      />
    </Part>
  );

/**
 * The apps the company asked Grasp to add, as Composio's catalog doesn't
 * have them: each a row to it on Apps asked for, which lists it once for
 * every company that asked.
 */
const AskedRows = ({ asked }: { asked: readonly AdminAppAsked[] }) =>
  asked.map((app) => (
    <Item asChild key={app.id}>
      <Link search={{ app: appKey(app.name) }} to="/connectors">
        <ItemContent>
          <ItemTitle>{app.name}</ItemTitle>
          <ItemDescription>
            {`Asked of Grasp on ${formatDate(app.askedAt)}: Composio doesn’t have it`}
          </ItemDescription>
        </ItemContent>
      </Link>
    </Item>
  ));

/** The apps it asked Grasp to add, while nothing else of its connections is known. */
const AskedOfGrasp = ({ asked }: { asked: readonly AdminAppAsked[] }) =>
  asked.length === 0 ? null : (
    <Part aria-labelledby="asked">
      <SectionHeader
        id="asked"
        size="sm"
        title="Asked of Grasp"
        variant="group"
      />
      <ItemGroup aria-labelledby="asked" separated>
        <AskedRows asked={asked} />
      </ItemGroup>
    </Part>
  );

/**
 * What the workflows need that isn't connected, what chats asked for that
 * waits on a decision, and the apps it asked Grasp to add: a row each,
 * or a line saying nothing is left.
 */
const StillToConnect = ({
  integrations,
}: {
  integrations: AdminIntegrations;
}) => {
  const { asked } = useOrganization().admin.snapshot;
  const apps = neededApps(integrations.needed);
  const { requests } = integrations;
  const none = apps.length === 0 && requests.length === 0 && asked.length === 0;
  return (
    <Part aria-labelledby="still">
      <SectionHeader
        description="What its workflows and chats need that isn’t connected: worth reaching out about."
        id="still"
        size="sm"
        title="Still to connect"
        variant="group"
      />
      {none ? (
        <Empty align="start" size="sm">
          <EmptyHeader>
            <EmptyDescription>
              Every app its workflows need is connected.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup aria-labelledby="still" separated>
          {apps.map((app) => (
            <Item key={app.key}>
              <ItemContent>
                <ItemTitle>{app.name}</ItemTitle>
                <ItemDescription>{`For ${formatList(app.workflows)}`}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Badge variant="warning">{needWords[app.state]}</Badge>
              </ItemActions>
            </Item>
          ))}
          {requests.map((request) => (
            <Item
              key={`${request.source}:${request.provider}:${request.decidedBy}`}
            >
              <ItemContent>
                <ItemTitle>{appName(request)}</ItemTitle>
                <ItemDescription>
                  {`Asked for in ${request.waiting} ${plural(request.waiting, "chat", "chats")} since ${formatDate(request.since)}, waiting on ${decidedByWords[request.decidedBy]}`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Badge variant="outline">Asked for</Badge>
              </ItemActions>
            </Item>
          ))}
          <AskedRows asked={asked} />
        </ItemGroup>
      )}
    </Part>
  );
};

/**
 * The Connectors page: before the company signed in, nothing; from a core
 * that doesn't report them, why; else its figures and parts.
 */
export const Connectors = () => {
  const { view, admin } = useOrganization();
  const { integrations, asked } = admin.snapshot;
  if (view.state.client === "none" || integrations === null) {
    const none = view.state.client === "none";
    return (
      <div {...stylex.props(styles.parts)}>
        <Empty>
          <EmptyHeader>
            <EmptyMedia icon={CableIcon} variant="icon" />
            <EmptyTitle level={2}>
              {none
                ? "Nothing connected yet"
                : "Its connections aren’t reported"}
            </EmptyTitle>
            <EmptyDescription>
              {none
                ? "The company starts with its sign-in, in its own onboarding. Everything else follows once it has named its team leads: Grasp waits on the company’s own admin."
                : "The company’s own Grasp doesn’t report what it connected yet, or what its workflows need. Once it does, each connection is here with who connected it, when, and how it stands."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
        <AskedOfGrasp asked={asked} />
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.parts)}>
      <Figures integrations={integrations} />
      <Connected connected={integrations.connected} />
      <PeoplesOwn integrations={integrations} />
      <StillToConnect integrations={integrations} />
    </div>
  );
};
