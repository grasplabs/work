/**
 * What a company connected, and what its workflows and chats still need,
 * as its core's snapshot says it (`integrations`), ported from the
 * prototype (grasplabs/prototype `components/admin/org-integrations.tsx`,
 * and `NeededPanel` in `components/admin/source-panels.tsx`). Only what
 * core sends: an app's name as its catalog says it isn't in the snapshot,
 * so a Composio toolkit is named after its slug.
 */

import type {
  AdminAppAsked,
  AdminConnection,
  AdminIntegrations,
  AdminNeeded,
} from "@grasp-os/shared/admin-snapshot";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { ArrowRightIcon, Icon } from "@grasp-os/ui/lib/icons";
import { colors, font } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { appKey } from "./integrations-asked.ts";
import { Done } from "./marks.tsx";
import { PanelNote } from "./panel.tsx";
import { sourceNames } from "./sections.ts";
import { formatDate, formatList, plural } from "./words.ts";

const styles = stylex.create({
  // What needs someone, in the warning's colour.
  attention: { color: colors.warning, textAlign: "end" },
  small: { fontSize: font.textXs },
});

/** Rows of a panel, edge to edge, a hairline between each. */
const Rows = ({ children }: { children: ReactNode }) => (
  <CardContent flush>
    <ItemGroup separated>{children}</ItemGroup>
  </CardContent>
);

/** The native connectors, by name. */
const nativeNames: Record<string, string> = {
  microsoft: "Microsoft 365",
  google: "Google Workspace",
};

/** An app's name: a native connector's own, or a Composio toolkit's slug in words. */
export const appName = ({
  source,
  provider,
}: {
  source: AdminConnection["source"];
  provider: string;
}): string => {
  const native = source === "native" ? nativeNames[provider] : undefined;
  return (
    native ??
    provider
      .split(/[_-]/u)
      .filter((word) => word !== "")
      .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
      .join(" ")
  );
};

/** How a connection stands, in words. */
const connectionWords: Record<AdminConnection["state"], string> = {
  works: "Works",
  again: "Needs signing in again",
  stopped: "Stopped at Composio",
  unread: "Composio didn’t say",
};

/** Why a workflow's binding isn't served, in words. */
export const needWords: Record<AdminNeeded["state"], string> = {
  unbound: "No connection approved yet",
  missing: "Not connected",
  stopped: "Stopped",
  hidden: "Hidden by its admin",
};

/** What Grasp may do there, as the connection says it. */
const accessOf = (connection: AdminConnection): string => {
  if (connection.tools === null) {
    return connection.account ?? "Its own account";
  }
  const count = connection.tools.length;
  return `${count} ${plural(count, "tool", "tools")} its admin allowed`;
};

/** One shared connection: what it is, who connected it and when, and how it stands. */
const ConnectedRow = ({ connection }: { connection: AdminConnection }) => {
  const name = appName(connection);
  const since = formatDate(connection.connectedAt);
  const by = connection.connectedBy;
  return (
    <Item size="sm">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>
          {connection.source === "composio" ? sourceNames.composio : "Grasp"}
          {connection.hidden ? ", hidden from its people" : ""}
        </ItemDescription>
      </ItemContent>
      <ItemContent>
        <Text as="span" size="sm">
          {accessOf(connection)}
        </Text>
        <ItemDescription>
          {by === null
            ? `Connected on ${since}.`
            : `Connected by ${by} on ${since}.`}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        {connection.state === "works" ? (
          <Done>{connectionWords.works}</Done>
        ) : (
          <span {...stylex.props(styles.attention)}>
            {connectionWords[connection.state]}
          </span>
        )}
      </ItemActions>
    </Item>
  );
};

/** The company's shared connections, then its people's own, counted by app. */
export const ConnectedRows = ({
  integrations,
}: {
  integrations: AdminIntegrations;
}) => {
  const { connected, personal } = integrations;
  if (connected.length === 0 && personal.length === 0) {
    return <PanelNote>Nothing connected yet beyond its sign-in.</PanelNote>;
  }
  return (
    <Rows>
      {connected.map((connection) => (
        <ConnectedRow
          connection={connection}
          key={`${connection.source}:${connection.provider}:${connection.connectedAt}`}
        />
      ))}
      {personal.map((app) => {
        const name = appName(app);
        const { people, again } = app;
        return (
          <Item key={`${app.source}:${app.provider}`} size="sm">
            <ItemContent>
              <ItemTitle>{name}</ItemTitle>
              <ItemDescription>
                {`${people} ${plural(people, "person", "people")} connected their own`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {again === 0 ? (
                <Done>{connectionWords.works}</Done>
              ) : (
                <span {...stylex.props(styles.attention)}>
                  {`${again} ${plural(again, "needs", "need")} signing in again`}
                </span>
              )}
            </ItemActions>
          </Item>
        );
      })}
    </Rows>
  );
};

/** An app the workflows need, with the workflows that need it and why. */
interface NeededApp {
  key: string;
  name: string;
  state: AdminNeeded["state"];
  workflows: string[];
}

/**
 * What the workflows need that is named: an approved app that isn't
 * connected, stopped or hidden, once per app and state, with every
 * workflow that needs it. A binding no connection was approved for names
 * no app; the Workflows section lists it.
 */
const neededApps = (needed: readonly AdminNeeded[]): NeededApp[] => {
  const apps = new Map<string, NeededApp>();
  for (const need of needed) {
    if (need.app === null) {
      continue;
    }
    const key = `${need.app.source}:${need.app.provider}:${need.state}`;
    const app = apps.get(key) ?? {
      key,
      name: appName(need.app),
      state: need.state,
      workflows: [],
    };
    if (!app.workflows.includes(need.workflow.name)) {
      app.workflows.push(need.workflow.name);
    }
    apps.set(key, app);
  }
  return [...apps.values()];
};

/** Who a chat's request waits on, in words. */
const decidedByWords: Record<
  AdminIntegrations["requests"][number]["decidedBy"],
  string
> = {
  person: "the person in the chat",
  admin: "the company’s admin",
};

/** What the workflows need that isn't connected, and what chats asked for that waits. */
export const StillToConnectRows = ({
  integrations,
}: {
  integrations: AdminIntegrations;
}) => {
  const apps = neededApps(integrations.needed);
  const { requests } = integrations;
  if (apps.length === 0 && requests.length === 0) {
    return <PanelNote>Every app the workflows need is connected.</PanelNote>;
  }
  return (
    <Rows>
      {apps.map((app) => (
        <Item key={app.key} size="sm">
          <ItemContent>
            <ItemTitle>{app.name}</ItemTitle>
            <ItemDescription>{`For ${formatList(app.workflows)}`}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <span {...stylex.props(styles.attention, styles.small)}>
              {needWords[app.state]}
            </span>
          </ItemActions>
        </Item>
      ))}
      {requests.map((request) => {
        const { waiting } = request;
        const since = formatDate(request.since);
        return (
          <Item
            key={`${request.source}:${request.provider}:${request.decidedBy}`}
            size="sm"
          >
            <ItemContent>
              <ItemTitle>{appName(request)}</ItemTitle>
              <ItemDescription>
                {`Asked for in ${waiting} ${plural(waiting, "chat", "chats")} since ${since}, waiting on ${decidedByWords[request.decidedBy]}`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Badge variant="outline">Asked for</Badge>
            </ItemActions>
          </Item>
        );
      })}
    </Rows>
  );
};

/**
 * The apps the company asked Grasp to add, as Composio's catalog doesn't
 * have them: each with when it asked, and the way to it on Apps asked
 * for, which lists it once for every company that asked.
 */
export const AskedOfGraspRows = ({
  asked,
}: {
  asked: readonly AdminAppAsked[];
}) => (
  <Rows>
    {asked.map((app) => (
      <Item key={app.id} size="sm">
        <ItemContent>
          <ItemTitle>{app.name}</ItemTitle>
          <ItemDescription>
            {`Asked for on ${formatDate(app.askedAt)}, as Composio doesn’t have it`}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            aria-label={`Asked of Grasp: open ${app.name} on Apps asked for`}
            asChild
            size="sm"
            variant="outline"
          >
            <Link search={{ app: appKey(app.name) }} to="/connectors">
              Asked of Grasp
              <Icon icon={ArrowRightIcon} />
            </Link>
          </Button>
        </ItemActions>
      </Item>
    ))}
  </Rows>
);
