import type {
  CatalogTool,
  ComposioToolRule,
  ListedConnection,
} from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import type { AppTool, AppToolChoice } from "./app/model.ts";
import type { Integration } from "./integrations.ts";

// What an admin chooses Grasp may do with a Composio toolkit's tools, when
// connecting it and later on its page: which tools to allow, and which of
// those only read; and an app's tools as the app parts draw
// them. Kept apart from the screens so what they submit can be tested
// without Composio.

/** One tool the admin allows, and whether they say it only reads. */
export interface AllowedTool {
  name: string;
  read: boolean;
  /** The input property naming its one resource, when its rule has one. */
  resource?: string;
}

/**
 * `allowed` after the admin allows `tool` or stops allowing it. A tool
 * newly allowed starts as Composio's hint says (`CatalogTool.readOnly`):
 * one without the hint changes things until the admin says otherwise.
 */
export const withAllowed = (
  allowed: readonly AllowedTool[],
  tool: CatalogTool,
  allow: boolean
): AllowedTool[] => {
  const others = allowed.filter(({ name }) => name !== tool.name);
  return allow ? [...others, { name: tool.name, read: tool.readOnly }] : others;
};

/**
 * `allowed` after the admin says whether the allowed tool `name` only
 * reads. A tool that isn't allowed stays out.
 */
export const withRead = (
  allowed: readonly AllowedTool[],
  name: string,
  read: boolean
): AllowedTool[] =>
  allowed.map((tool) => (tool.name === name ? { ...tool, read } : tool));

/**
 * What connecting or a change submits: a tool marked read-only, or with a
 * resource property, as its rule, any other by name alone, which connect
 * takes for a side effect. A change replaces the whole list, so a rule's
 * resource goes with it, whatever was switched.
 */
export const toolRules = (
  allowed: readonly AllowedTool[]
): (string | ComposioToolRule)[] =>
  allowed.map(({ name, read, resource }) => {
    if (!read && resource === undefined) {
      return name;
    }
    return {
      name,
      ...(read ? { read } : {}),
      ...(resource === undefined ? {} : { resource }),
    };
  });

/**
 * A tool's action name in plain words: `GMAIL_SEND_EMAIL` reads "Send
 * email", `mail.list` reads "Mail list". The provider's own words, so not
 * translated.
 */
export const toolWords = (name: string, app: string): string => {
  const prefix = `${app.replaceAll(/[^a-z0-9]/giu, "").toUpperCase()}_`;
  const bare = name.toUpperCase().startsWith(prefix)
    ? name.slice(prefix.length)
    : name;
  const words = bare
    .replaceAll(/[._-]+/gu, " ")
    .replaceAll(/(?<lower>[a-z])(?<upper>[A-Z])/gu, "$<lower> $<upper>")
    .trim()
    .toLowerCase();
  return words === ""
    ? name
    : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/**
 * What `connection` allows now, each tool with whether it only reads and
 * the resource property its rule names, so a change keeps it.
 */
export const allowedOf = (connection: ListedConnection): AllowedTool[] =>
  (connection.tools ?? []).map((name) => {
    const resource = connection.toolResources?.[name];
    return {
      name,
      read: connection.readTools?.includes(name) ?? false,
      ...(resource === undefined ? {} : { resource }),
    };
  });

/**
 * The connection whose tools `identity` may change on `integration`'s page:
 * its active shared Composio connection, for an admin who isn't Grasp
 * staff (connect leaves the choice to the client's admins). A native
 * connector's tools are fixed.
 */
export const changeableConnectionOf = (
  integration: Integration,
  identity: Pick<Identity, "role" | "staff">
): ListedConnection | undefined =>
  isAdmin(identity.role) && !identity.staff && integration.source === "composio"
    ? integration.connections.find(
        ({ scope, status, tools }) =>
          scope === "shared" && status === "active" && tools !== undefined
      )
    : undefined;

/**
 * An app's tools as the app parts draw them: each in plain
 * words, reading where its provider says it only reads, and what Grasp
 * may do with it through `connection`. A Composio connection allows the
 * tools its admin chose, a Read only where both the admin's rule and the
 * provider say it only reads; a native one allows every tool; with none,
 * nothing is allowed. A tool the connection allows that the toolkit no
 * longer offers comes last, under `goneGroup`, so it can still be taken
 * away.
 */
export const appToolsOf = (
  tools: readonly CatalogTool[],
  integration: Pick<Integration, "id" | "source">,
  connection: ListedConnection | undefined,
  goneGroup: string
): AppTool[] => {
  const allowed =
    connection === undefined || integration.source !== "composio"
      ? undefined
      : allowedOf(connection);
  const choiceOf = (tool: CatalogTool): AppToolChoice => {
    if (connection === undefined) {
      return "never";
    }
    if (allowed === undefined) {
      return tool.readOnly ? "read" : "write";
    }
    const rule = allowed.find(({ name }) => name === tool.name);
    if (rule === undefined) {
      return "never";
    }
    return rule.read && tool.readOnly ? "read" : "write";
  };
  const listed = tools.map((tool): AppTool => ({
    id: tool.name,
    name: toolWords(tool.name, integration.id),
    ...(tool.description === null ? {} : { description: tool.description }),
    kind: tool.readOnly ? "read" : "write",
    choice: choiceOf(tool),
  }));
  const offered = new Set(tools.map(({ name }) => name));
  const gone = (allowed ?? [])
    .filter(({ name }) => !offered.has(name))
    .map(({ name }): AppTool => ({
      id: name,
      name: toolWords(name, integration.id),
      kind: "write",
      choice: "write",
      group: goneGroup,
    }));
  return [...listed, ...gone];
};

/**
 * `allowed` after a change from the app's page: a tool set to Never is
 * taken away, one set to Read or Write is allowed as that, keeping its
 * resource rule. Tools the change doesn't name stay as they were.
 */
export const withChoices = (
  allowed: readonly AllowedTool[],
  changes: readonly { id: string; choice: AppToolChoice }[]
): AllowedTool[] => {
  const next = new Map(changes.map(({ id, choice }) => [id, choice]));
  const kept = allowed.flatMap((tool) => {
    const choice = next.get(tool.name);
    if (choice === undefined) {
      return [tool];
    }
    return choice === "never" ? [] : [{ ...tool, read: choice === "read" }];
  });
  const known = new Set(allowed.map(({ name }) => name));
  const added = changes
    .filter(({ id, choice }) => choice !== "never" && !known.has(id))
    .map(({ id, choice }) => ({ name: id, read: choice === "read" }));
  return [...kept, ...added];
};
