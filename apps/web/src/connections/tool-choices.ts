import type { CatalogTool, ComposioToolRule } from "@grasp-os/shared/connect";

// What the admin chose in the dialog for connecting a Composio toolkit:
// which tools to allow, and which of those only read. Kept apart from the
// dialog so what it submits can be tested without Composio.

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
