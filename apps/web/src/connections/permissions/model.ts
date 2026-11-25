import type { CatalogTool } from "@grasp-os/shared/connect";

import { toolWords } from "../tool-choices.ts";
import type { AllowedTool } from "../tool-choices.ts";

// What the connect dialog's permission concepts share: each tool sorted by
// how much harm it can do, and the choices an admin makes in bulk. Only the
// provider's hint says a tool reads (`CatalogTool.readOnly`); a tool without
// it changes things, and one whose action deletes, cancels, removes or
// revokes is the riskiest of those. Grasp never checks a hint: a tool the
// admin marks Read runs without asking, so nothing here marks a tool Read
// that its provider didn't.

/** How much a tool can do: look only, create or change, or take away. */
export type ToolKind = "look" | "change" | "remove";

/** The kinds, the safest first. */
export const toolKinds: readonly ToolKind[] = ["look", "change", "remove"];

// The action's first word that makes a tool that changes things one that
// takes something away, often for good.
const removing =
  /^(?:delete|cancel|remove|revoke|destroy|archive|trash|purge|disconnect|unsubscribe|deactivate|disable|erase|clear|reset|void|refund|ban|block|kick|close)\b/iu;

const kindOf = (readOnly: boolean, name: string): ToolKind => {
  if (readOnly) {
    return "look";
  }
  return removing.test(name) ? "remove" : "change";
};

/** A tool, in plain words and sorted by what it can do. */
export interface SortedTool {
  tool: CatalogTool;
  /** Its action in plain words: the provider's, so not translated. */
  name: string;
  kind: ToolKind;
  /** Its provider says to use another instead: never allowed by a bulk choice. */
  deprecated: boolean;
}

const deprecatedMark = /\bdeprecated\b/iu;

/** `tool` sorted: what its provider says it does, and what its name says. */
export const sortTool = (tool: CatalogTool, app: string): SortedTool => {
  const name = toolWords(tool.name, app)
    .replace(/\s*\(deprecated\)\s*$/iu, "")
    // `USER_S_EVENT_TYPES` reads "User's event types".
    .replaceAll(/(?<word>\w) s\b/gu, "$<word>'s");
  const kind = kindOf(tool.readOnly, name);
  return {
    tool,
    name,
    kind,
    deprecated:
      deprecatedMark.test(tool.description ?? "") ||
      deprecatedMark.test(tool.name),
  };
};

/** Every tool sorted: by kind, the current ones before deprecated ones, then by name. */
export const sortTools = (
  tools: readonly CatalogTool[],
  app: string
): SortedTool[] =>
  tools
    .map((tool) => sortTool(tool, app))
    .toSorted(
      (one, other) =>
        toolKinds.indexOf(one.kind) - toolKinds.indexOf(other.kind) ||
        Number(one.deprecated) - Number(other.deprecated) ||
        one.name.localeCompare(other.name)
    );

/** The tools of one kind. */
export const ofKind = (
  sorted: readonly SortedTool[],
  kind: ToolKind
): SortedTool[] => sorted.filter((tool) => tool.kind === kind);

/** Allowed as its provider says: Read where it says the tool only reads. */
const asHinted = ({ tool }: SortedTool): AllowedTool => ({
  name: tool.name,
  read: tool.readOnly,
});

/**
 * Where the dialog starts: every current tool that only looks, as Read.
 * Nothing that changes things is on until the admin turns it on.
 */
export const startingChoice = (sorted: readonly SortedTool[]): AllowedTool[] =>
  sorted
    .filter(({ kind, deprecated }) => kind === "look" && !deprecated)
    .map(asHinted);

/**
 * `allowed` with `tools` all on (as their provider says) or all off;
 * deprecated ones are turned on only when named one at a time.
 */
export const withAll = (
  allowed: readonly AllowedTool[],
  tools: readonly SortedTool[],
  on: boolean
): AllowedTool[] => {
  const names = new Set(tools.map(({ tool }) => tool.name));
  const others = allowed.filter(({ name }) => !names.has(name));
  if (!on) {
    return others;
  }
  const kept = allowed.filter(({ name }) => names.has(name));
  const added = tools
    .filter(
      ({ tool, deprecated }) =>
        !deprecated && !kept.some(({ name }) => name === tool.name)
    )
    .map(asHinted);
  return [...others, ...kept, ...added];
};

/** One tool's choice: off, Read, or Write. */
export type Choice = "off" | "read" | "write";

export const choiceOf = (
  allowed: readonly AllowedTool[],
  name: string
): Choice => {
  const found = allowed.find((tool) => tool.name === name);
  if (found === undefined) {
    return "off";
  }
  return found.read ? "read" : "write";
};

/** `allowed` with one tool set to `choice`. */
export const withChoice = (
  allowed: readonly AllowedTool[],
  name: string,
  choice: Choice
): AllowedTool[] => {
  const others = allowed.filter((tool) => tool.name !== name);
  return choice === "off"
    ? others
    : [...others, { name, read: choice === "read" }];
};

/** How many of `tools` are on. */
export const countOn = (
  allowed: readonly AllowedTool[],
  tools: readonly SortedTool[]
): number =>
  tools.filter(({ tool }) => allowed.some(({ name }) => name === tool.name))
    .length;

/** What the allowed tools add up to: how many run without asking, and how many ask first. */
export const tally = (
  allowed: readonly AllowedTool[]
): { read: number; asks: number } => ({
  read: allowed.filter(({ read }) => read).length,
  asks: allowed.filter(({ read }) => !read).length,
});

/** A preset of concept A: what Grasp may do, in one choice. */
export type Preset = "look" | "change" | "all" | "own";

/** The kinds a preset turns on. */
export const presetKinds: Readonly<
  Record<Exclude<Preset, "own">, readonly ToolKind[]>
> = {
  look: ["look"],
  change: ["look", "change"],
  all: ["look", "change", "remove"],
};

/** The tools a preset turns on, as their provider says. */
export const presetChoice = (
  sorted: readonly SortedTool[],
  preset: Exclude<Preset, "own">
): AllowedTool[] =>
  sorted
    .filter(
      ({ kind, deprecated }) =>
        presetKinds[preset].includes(kind) && !deprecated
    )
    .map(asHinted);

/** A choice as one string, the same whatever its order. */
const keyOf = (list: readonly AllowedTool[]): string =>
  list
    .map(({ name, read }) => `${name}:${read ? "r" : "w"}`)
    .toSorted()
    .join(",");

/** The preset `allowed` is, or `own` when it is none of them. */
export const presetOf = (
  sorted: readonly SortedTool[],
  allowed: readonly AllowedTool[]
): Preset => {
  const now = keyOf(allowed);
  const found = (["look", "change", "all"] as const).find(
    (preset) => keyOf(presetChoice(sorted, preset)) === now
  );
  return found ?? "own";
};

/** A tool's choice once its box is ticked or cleared: on as its provider says. */
export const ticked = (tool: CatalogTool, on: boolean): Choice => {
  if (!on) {
    return "off";
  }
  return tool.readOnly ? "read" : "write";
};

/** A box over `on` of `total`: ticked, clear, or a dash between. */
export const boxOf = (on: number, total: number): boolean | "indeterminate" => {
  if (on === 0) {
    return false;
  }
  return on === total ? true : "indeterminate";
};

const presets: ReadonlySet<string> = new Set(["look", "change", "all", "own"]);

export const isPreset = (value: unknown): value is Preset =>
  typeof value === "string" && presets.has(value);
