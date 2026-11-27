/**
 * The words for what a company connected, and what its workflows and
 * chats still need, as its core's snapshot says it (`integrations`), for
 * its Connectors (src/admin/connectors.tsx) and the workflows waiting on
 * a connection. Only what core sends: an app's name as its catalog says
 * it isn't in the snapshot, so a Composio toolkit is named after its slug.
 */

import type {
  AdminConnection,
  AdminIntegrations,
  AdminNeeded,
} from "@grasp-os/shared/admin-snapshot";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { Attention } from "./marks.tsx";
import { PartNote } from "./page-part.tsx";
import { plural } from "./words.ts";

const styles = stylex.create({
  // Each binding it waits on, a line each.
  needs: { display: "flex", flexDirection: "column", gap: space["1"] },
});

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
export const connectionWords: Record<AdminConnection["state"], string> = {
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
export const accessOf = (connection: AdminConnection): string => {
  if (connection.tools === null) {
    return connection.account ?? "Its own account";
  }
  const count = connection.tools.length;
  return `${count} ${plural(count, "tool", "tools")} its admin allowed`;
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
export const neededApps = (needed: readonly AdminNeeded[]): NeededApp[] => {
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
export const decidedByWords: Record<
  AdminIntegrations["requests"][number]["decidedBy"],
  string
> = {
  person: "the person in the chat",
  admin: "the company’s admin",
};

/** One workflow, and each of its bindings no working connection serves. */
interface WaitingWorkflow {
  id: string;
  name: string;
  needs: AdminNeeded[];
}

const waitingWorkflows = (
  needed: readonly AdminNeeded[]
): WaitingWorkflow[] => {
  const workflows = new Map<string, WaitingWorkflow>();
  for (const need of needed) {
    const workflow = workflows.get(need.workflow.id) ?? {
      id: need.workflow.id,
      name: need.workflow.name,
      needs: [],
    };
    workflow.needs.push(need);
    workflows.set(need.workflow.id, workflow);
  }
  return [...workflows.values()];
};

/** What one binding waits on: its app and why, or that no app was approved for it. */
const needLine = (need: AdminNeeded): string =>
  need.app === null
    ? `${need.alias}: ${needWords.unbound}`
    : `${need.alias}: ${appName(need.app)}, ${needWords[need.state].toLowerCase()}`;

/**
 * The company's workflows that can't run as they are, for a connection:
 * each with every binding of its current version that no working
 * connection serves.
 */
export const WaitingOnConnectionsRows = ({
  integrations,
}: {
  integrations: AdminIntegrations;
}) => {
  const workflows = waitingWorkflows(integrations.needed);
  if (workflows.length === 0) {
    return <PartNote>No workflow waits on a connection.</PartNote>;
  }
  return (
    <ItemGroup aria-label="Workflows waiting on a connection" separated>
      {workflows.map((workflow) => (
        <Item key={workflow.id} size="sm">
          <ItemContent>
            <ItemTitle>{workflow.name}</ItemTitle>
            <ItemDescription>
              <span {...stylex.props(styles.needs)}>
                {workflow.needs.map((need) => (
                  <Attention key={need.alias}>{needLine(need)}</Attention>
                ))}
              </span>
            </ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
};
