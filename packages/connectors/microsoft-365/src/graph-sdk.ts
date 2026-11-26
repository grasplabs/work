import { ToolError, v } from "@grasp-os/sdk/connector";

// What the Microsoft Graph tools written on @grasp-os/sdk/connector share:
// the values that name Graph's things, its paging, and the tag a write
// carries its call's effect key in.
//
// Failures need nothing here: the SDK's API client already turns Graph's
// answer into the error a caller sees, with Graph's own error code
// (`error.code`, such as `ErrorItemNotFound`) and never its message, as
// graph.ts's `graphFailure` did.

export const graphHost = "graph.microsoft.com";

/** Graph's v1.0 API: every route is under it. */
export const graphBase = "/v1.0";

/**
 * A Graph ID (a message's, an event's, an item's, a list's) or a
 * well-known folder name (`inbox`), in Graph's alphabet: letters, digits
 * and `-_=!.`. `v` has no pattern, so `checkIds` holds it to that.
 */
export const graphId = v.string().min(1).max(512);

const idPattern = /^[\w=!.-]+$/u;

/**
 * A mailbox: its address (`invoices@example.com`) or its user ID. As a
 * path parameter it is held to one segment, never `.` or `..`, by the
 * API client before anything is sent.
 */
export const mailbox = v.string().min(1).max(256);

/**
 * A drive: a OneDrive's or a SharePoint document library's ID, `b!...`.
 * `checkDrive` holds it to that.
 */
export const drive = v.string().min(3).max(256);

const drivePattern = /^b![\w=!.-]+$/u;

/** Refuses `value`, before anything is sent, unless it fits `pattern`. */
const refuseUnless = (pattern: RegExp, name: string, value: string): void => {
  if (!pattern.test(value)) {
    throw new ToolError(`Invalid input: ${name} isn't a Microsoft 365 ID`, {
      code: "invalid",
    });
  }
};

/** Refuses, before anything is sent, any of `ids` that isn't a Graph ID. */
export const checkIds = (
  ids: Readonly<Record<string, string | undefined>>
): void => {
  for (const [name, value] of Object.entries(ids)) {
    if (value !== undefined) {
      refuseUnless(idPattern, name, value);
    }
  }
};

/** Refuses, before anything is sent, a drive that isn't a drive's ID. */
export const checkDrive = (value: string): void => {
  refuseUnless(drivePattern, "drive", value);
};

/** How many items a page holds: Graph's `$top`. */
export const top = v.number().integer().min(1).max(50).optional();

/** Where a list goes on: a previous page's `next`, with the same arguments. */
export const next = v.string().min(1).max(4096).optional();

/** A page of a Graph collection, as Graph answers it. */
export const graphPage = <Item extends Parameters<typeof v.array>[0]>(
  item: Item
) =>
  v.object({
    value: v.array(item),
    "@odata.nextLink": v.string().optional(),
  });

/**
 * The query parameters that carry Graph's position in a collection. A
 * next page is asked for on the tool's own route, with the tool's own
 * query and only these taken from Graph's `@odata.nextLink`: the link is
 * never followed as a URL.
 */
const positionParameters = ["$skip", "$skiptoken"];

/**
 * A page's `next` for Graph's `@odata.nextLink`, or null at the end: only
 * its position (`$skip`, `$skiptoken`).
 */
export const nextOf = (nextLink: string | undefined): string | null => {
  if (nextLink === undefined) {
    return null;
  }
  let link: URL;
  try {
    link = new URL(nextLink);
  } catch {
    throw new Error("Microsoft 365's next page link isn't a URL");
  }
  const position = new URLSearchParams();
  for (const name of positionParameters) {
    const value = link.searchParams.get(name);
    if (value !== null) {
      position.set(name, value);
    }
  }
  if (link.hostname !== graphHost || position.size === 0) {
    throw new Error("Microsoft 365's next page link has no position");
  }
  return position.toString();
};

/**
 * The query that asks for the page `at` (a `next` from `nextOf`) names:
 * none for the first page.
 */
export const positionOf = (
  at: string | undefined
): Readonly<Record<string, string>> => {
  if (at === undefined) {
    return {};
  }
  const given = new URLSearchParams(at);
  const position: Record<string, string> = {};
  for (const name of positionParameters) {
    const value = given.get(name);
    if (value !== null) {
      position[name] = value;
    }
  }
  if (Object.keys(position).length === 0) {
    throw new ToolError("That isn't a page this tool handed out", {
      code: "invalid",
    });
  }
  return position;
};

/**
 * The extended property what this connector makes carries its call's
 * effect key in, so a call of unknown outcome can find it again: a named
 * MAPI string property in a property set of our own. Graph keeps it on a
 * message (and the Sent Items copy of one it sent), an event and a To Do
 * task.
 */
export const effectPropertyId =
  "String {c30928d5-7050-44f2-99d3-ce09d5cd6e60} Name GraspEffect";

/** The fields a write's body adds to carry the call's effect `key`, if any. */
export const effectTag = (key: string | null) =>
  key === null
    ? {}
    : { singleValueExtendedProperties: [{ id: effectPropertyId, value: key }] };

/**
 * Graph's `$filter` for what carries the effect `key`: mail and events
 * take it; To Do doesn't, and is read with the tag expanded instead.
 */
export const effectFilter = (key: string): string =>
  `singleValueExtendedProperties/Any(ep: ep/id eq '${effectPropertyId}' and ep/value eq '${key}')`;
