/**
 * Google's own rule for the calls the syncs make: each method answers only
 * a token that holds one of the scopes its reference page lists under
 * "Authorization scopes". The mocked Google in the sync tests refuses any
 * other call with a 403, as Google does, so a sync that calls a method the
 * connection's grant doesn't cover fails in a test, not in a client's
 * tenant.
 */
import { classesOnByDefault, googleRights } from "../src/provider-rights.ts";
import type { fakeProviders } from "./oauth-provider.ts";

const scope = (name: string): string =>
  name.startsWith("https://")
    ? name
    : `https://www.googleapis.com/auth/${name}`;

/**
 * Drive's file and change reads (files.list, files.get, files.export,
 * changes.list, changes.getStartPageToken). The reference pages also list
 * `drive.file`, `drive.appdata`, `drive.photos.readonly` and
 * `drive.meet.readonly`, but those see only some of a person's files, so a
 * sync on them would be silently partial: they are left out here, the
 * stricter rule.
 * https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get
 */
const driveMetadata = [
  "drive",
  "drive.readonly",
  "drive.metadata",
  "drive.metadata.readonly",
].map(scope);
/** A file's bytes or export need more than metadata. */
const driveContent = ["drive", "drive.readonly"].map(scope);

/**
 * Gmail's reads (users.getProfile, messages.list, messages.get,
 * messages.attachments.get, history.list).
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
 */
const gmailRead = [
  "https://mail.google.com/",
  "gmail.modify",
  "gmail.readonly",
].map(scope);

/** One call: its method, its path, and the scopes any one of which allows it. */
interface ScopeRule {
  path: RegExp;
  content?: (url: URL) => boolean;
  scopes: readonly string[];
}

const rules: readonly ScopeRule[] = [
  // drives.list and drives.get: `drive` or `drive.readonly` only.
  // https://developers.google.com/workspace/drive/api/reference/rest/v3/drives/list
  { path: /^\/drive\/v3\/drives(?:\/[^/]+)?$/u, scopes: driveContent },
  {
    path: /^\/drive\/v3\/changes(?:\/startPageToken)?$/u,
    scopes: driveMetadata,
  },
  { path: /^\/drive\/v3\/files\/[^/]+\/export$/u, scopes: driveContent },
  {
    path: /^\/drive\/v3\/files(?:\/[^/]+)?$/u,
    content: (url) => url.searchParams.get("alt") === "media",
    scopes: driveMetadata,
  },
  {
    path: /^\/gmail\/v1\/users\/[^/]+\/(?:profile|messages|history)(?:\/.*)?$/u,
    scopes: gmailRead,
  },
  // calendarList.get, which takes `primary`.
  // https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/get
  {
    path: /^\/calendar\/v3\/users\/me\/calendarList\/[^/]+$/u,
    scopes: [
      "calendar",
      "calendar.readonly",
      "calendar.app.created",
      "calendar.calendarlist",
      "calendar.calendarlist.readonly",
    ].map(scope),
  },
  // events.list.
  // https://developers.google.com/workspace/calendar/api/v3/reference/events/list
  {
    path: /^\/calendar\/v3\/calendars\/[^/]+\/events$/u,
    scopes: [
      "calendar",
      "calendar.readonly",
      "calendar.events",
      "calendar.events.readonly",
      "calendar.app.created",
      "calendar.events.freebusy",
      "calendar.events.owned",
      "calendar.events.owned.readonly",
      "calendar.events.public.readonly",
    ].map(scope),
  },
  // calendars.get.
  // https://developers.google.com/workspace/calendar/api/v3/reference/calendars/get
  {
    path: /^\/calendar\/v3\/calendars\/[^/]+$/u,
    scopes: [
      "calendar",
      "calendar.readonly",
      "calendar.app.created",
      "calendar.calendars",
      "calendar.calendars.readonly",
    ].map(scope),
  },
];

/**
 * What a person's own Google connection holds once the sync runs: what it
 * is asked for by the classes on by default, and the sync's own read of
 * their Drive (`drive.readonly`), which core's sync run adds (GRA-1758,
 * PR I).
 */
export const syncGrant = [
  ...googleRights(classesOnByDefault),
  scope("drive.readonly"),
].join(" ");

/**
 * Google's 403 for a call whose token holds none of the scopes it needs;
 * undefined when it may go on (or isn't a call the syncs make).
 */
export const scopeRefusal = (
  providers: ReturnType<typeof fakeProviders>,
  request: Request,
  url: URL
): Response | undefined => {
  const rule = rules.find(({ path }) => path.test(url.pathname));
  if (rule === undefined) {
    return undefined;
  }
  const scopes = rule.content?.(url) === true ? driveContent : rule.scopes;
  const token =
    request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
  const granted = (providers.state.holders.get(token)?.granted ?? "").split(
    " "
  );
  return scopes.some((each) => granted.includes(each))
    ? undefined
    : Response.json(
        {
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            errors: [{ reason: "insufficientPermissions" }],
          },
        },
        { status: 403 }
      );
};
