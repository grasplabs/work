/**
 * What a company connected, and what its workflows and chats still need,
 * as its core's snapshot says it (`integrations`), ported from the
 * prototype (grasplabs/prototype `components/admin/org-integrations.tsx`,
 * and `NeededPanel` in `components/admin/source-panels.tsx`). Only what
 * core sends: an app's name as its catalog says it isn't in the snapshot,
 * so a Composio toolkit is named after its slug.
 */
import type {
  AdminConnection,
  AdminIntegrations,
  AdminNeeded,
} from "@grasp-os/shared/admin-snapshot";
import { Badge } from "@grasp-os/ui/components/badge";

import { Done } from "./parts.tsx";
import { sourceNames } from "./sections.ts";
import { formatDate, formatList, plural } from "./words.ts";

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
    <li className="grid items-center gap-x-6 gap-y-2 border-t px-5 py-3 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,14rem)]">
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        <span className="text-muted-foreground text-xs">
          {connection.source === "composio" ? sourceNames.composio : "Grasp"}
          {connection.hidden ? ", hidden from its people" : ""}
        </span>
      </span>
      <span className="flex min-w-0 flex-col">
        <span>{accessOf(connection)}</span>
        <span className="text-muted-foreground text-xs">
          {by === null
            ? `Connected on ${since}.`
            : `Connected by ${by} on ${since}.`}
        </span>
      </span>
      <span className="flex flex-col items-start lg:items-end">
        {connection.state === "works" ? (
          <Done>{connectionWords.works}</Done>
        ) : (
          <span className="text-status-attention lg:text-right">
            {connectionWords[connection.state]}
          </span>
        )}
      </span>
    </li>
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
    return (
      <p className="text-muted-foreground border-t px-5 py-4">
        Nothing connected yet beyond its sign-in.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
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
          <li
            className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t px-5 py-3"
            key={`${app.source}:${app.provider}`}
          >
            <span className="flex min-w-0 flex-col">
              <span>{name}</span>
              <span className="text-muted-foreground text-xs">
                {`${people} ${plural(people, "person", "people")} connected their own`}
              </span>
            </span>
            {again === 0 ? (
              <Done>{connectionWords.works}</Done>
            ) : (
              <span className="text-status-attention">
                {`${again} ${plural(again, "needs", "need")} signing in again`}
              </span>
            )}
          </li>
        );
      })}
    </ul>
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
    return (
      <p className="text-muted-foreground border-t px-5 py-4">
        Every app the workflows need is connected.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {apps.map((app) => {
        const workflows = formatList(app.workflows);
        return (
          <li
            className="flex items-center gap-3 border-t px-5 py-3"
            key={app.key}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{app.name}</span>
              <span className="text-muted-foreground text-xs">
                {`For ${workflows}`}
              </span>
            </span>
            <span className="text-status-attention flex-none text-xs">
              {needWords[app.state]}
            </span>
          </li>
        );
      })}
      {requests.map((request) => {
        const name = appName(request);
        const { waiting } = request;
        const since = formatDate(request.since);
        return (
          <li
            className="flex items-center gap-3 border-t px-5 py-3"
            key={`${request.source}:${request.provider}:${request.decidedBy}`}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span>{name}</span>
              <span className="text-muted-foreground text-xs">
                {`Asked for in ${waiting} ${plural(waiting, "chat", "chats")} since ${since}, waiting on ${decidedByWords[request.decidedBy]}`}
              </span>
            </span>
            <Badge variant="outline">Asked for</Badge>
          </li>
        );
      })}
    </ul>
  );
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
    return (
      <p className="text-muted-foreground border-t px-5 py-4">
        No workflow waits on a connection.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {workflows.map((workflow) => (
        <li
          className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 border-t px-5 py-3"
          key={workflow.id}
        >
          <span className="min-w-0">{workflow.name}</span>
          <span className="text-status-attention flex flex-col text-xs lg:items-end">
            {workflow.needs.map((need) => (
              <span key={need.alias}>{needLine(need)}</span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
};
