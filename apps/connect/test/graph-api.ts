/**
 * Microsoft Graph and the tenant's SharePoint, as the Microsoft 365
 * connector reaches them through connect's egress, serving the recorded
 * answers in test/fixtures/graph.ts. Any other host takes whatever it is
 * sent, as an attacker's would. `throttle` makes Graph answer the next
 * request with a 429, `throttleWrite` the next write; `failWrite` answers
 * the next write with an error, and `loseWriteAnswer` carries the next
 * write out and loses its answer. Events it makes or changes it keeps for
 * the test, and holds a change to the `If-Match` etag it is sent.
 */
import { egressHeader } from "@grasp-os/connector-kit/manifest";
import {
  effectPropertyId,
  graphHost,
} from "@grasp-os/connector-microsoft-365/graph";
import { beforeEach } from "vite-plus/test";
import { z } from "zod";

import {
  attachment,
  attachmentPage,
  childrenPage,
  downloadUrl,
  draft,
  eventDetail,
  eventPage,
  invoicePdf,
  controlText,
  item,
  itemIds,
  mailFolder,
  message,
  messagePage,
  moved,
  notFound,
  reportText,
  searchResults,
  sharePointHost,
  spoofedId,
  throttled,
} from "./fixtures/graph.ts";
import { fakeProvider, json, route as routeOn } from "./internet.ts";
import type { ProviderRoute } from "./internet.ts";

const users = String.raw`^/v1\.0/users/(?<mailbox>[^/]+)`;
const drives = String.raw`^/v1\.0/drives/(?<drive>[^/]+)`;

const parts = ["mailbox", "drive", "id"] as const;

type Part = (typeof parts)[number];

/** The number in a message or event ID of the fixtures. */
const numberOf = (id: string): number => Number(id.at(-2)) || 1;

const draftSchema = z.object({ subject: z.string() });

/** A message as Graph takes it, with the extended properties it carries. */
const taggedSchema = z.object({
  singleValueExtendedProperties: z
    .array(z.object({ id: z.string(), value: z.string() }))
    .optional(),
});

/**
 * The messages Graph made that carry an effect key, by key: the mailbox
 * they are in and their ID. Cleared before each test.
 */
const tagged = new Map<string, { mailbox: string; id: string }>();

/** Keeps the effect key a made message carries, if it carries one. */
const keepTag = (mailbox: string, id: string, made: unknown): void => {
  const value = taggedSchema
    .safeParse(made)
    .data?.singleValueExtendedProperties?.find(
      (property) => property.id === effectPropertyId
    )?.value;
  if (value !== undefined) {
    tagged.set(value, { mailbox, id });
  }
};

/** Runs once while Graph answers the next lookup by effect key. */
let duringLookup: (() => Promise<void>) | undefined;

type GraphEvent = Record<string, unknown> & {
  id: string;
  "@odata.etag": string;
  attendees: unknown[];
};

/**
 * The events Graph made or changed, by mailbox and ID; any other is the
 * fixtures' as it was. Cleared before each test.
 */
const events = new Map<string, GraphEvent>();

/** The events Graph made that carry an effect key, by key. */
const taggedEvents = new Map<string, { mailbox: string; id: string }>();

const eventKey = (mailbox: string, id: string): string => `${mailbox}/${id}`;

/** An event of `mailbox` as Graph holds it now. */
const eventOf = (mailbox: string, id: string): GraphEvent =>
  events.get(eventKey(mailbox, id)) ?? eventDetail(mailbox, numberOf(id));

/** Whether a guest joins the event the next update reads, once it has read it. */
let inviteDuringRead = false;

const newEtag = (): string => `W/"${crypto.randomUUID()}"`;

/** The time zone a request's `Prefer` header asks for, UTC if none. */
const zoneOf = (request: Request): string =>
  /outlook\.timezone="(?<zone>[^"]+)"/u.exec(
    request.headers.get("prefer") ?? ""
  )?.groups?.zone ?? "UTC";

const graphTimeSchema = z.object({
  dateTime: z.string(),
  timeZone: z.string(),
});

/** How long a time without its seconds is: `2026-10-26T14:30`. */
const minutesOnly = 16;

/**
 * A time as Graph answers it, in the zone it was asked in. Never
 * converted: these tests read in the zone they write in.
 */
const answeredTime = (
  { dateTime }: z.infer<typeof graphTimeSchema>,
  zone: string
): z.infer<typeof graphTimeSchema> => ({
  dateTime: `${dateTime.length === minutesOnly ? `${dateTime}:00` : dateTime.slice(0, 19)}.0000000`,
  timeZone: zone,
});

const eventChangesSchema = z.object({
  start: graphTimeSchema.optional(),
  end: graphTimeSchema.optional(),
});

/** `event` with `changes` made to it, its times as asked in `zone`. */
const changed = (
  event: GraphEvent,
  changes: Record<string, unknown>,
  zone: string
): GraphEvent => {
  const { start, end } = eventChangesSchema.parse(changes);
  return {
    ...event,
    ...changes,
    ...(start === undefined ? {} : { start: answeredTime(start, zone) }),
    ...(end === undefined ? {} : { end: answeredTime(end, zone) }),
    "@odata.etag": newEtag(),
  };
};

/** The effect key a lookup's `$filter` asks for, if it asks for one. */
const keyFilter =
  /^singleValueExtendedProperties\/Any\(ep: ep\/id eq '(?<id>[^']+)' and ep\/value eq '(?<key>[^']+)'\)$/u;

/** Graph's answer to a lookup of a message by its effect key. */
const foundByKey = (mailbox: string, filter: string): Response => {
  const asked = keyFilter.exec(filter)?.groups;
  if (asked?.id !== effectPropertyId) {
    return json({ error: { code: "BadRequest" } }, 400);
  }
  const found = tagged.get(asked.key ?? "");
  return json({
    value:
      found?.mailbox === mailbox
        ? [
            {
              id: found.id,
              conversationId: "AAQkAGE1M2IyNGNmLTI5MTktFound=",
              webLink: `https://outlook.office365.com/owa/?ItemID=${found.id}`,
            },
          ]
        : [],
  });
};

const route = (
  method: string,
  path: string,
  answer: ProviderRoute<Part>["answer"]
): ProviderRoute<Part> => routeOn(graphHost, method, path, answer);

const graphRoutes: ProviderRoute<Part>[] = [
  route(
    "GET",
    `${users}(?:/mailFolders/[^/]+)?/messages`,
    async ({ mailbox, query }) => {
      const filter = query.get("$filter") ?? "";
      if (!filter.startsWith("singleValueExtendedProperties/")) {
        return json(messagePage(mailbox, Number(query.get("$skip") ?? 0)));
      }
      const meanwhile = duringLookup;
      duringLookup = undefined;
      await meanwhile?.();
      return foundByKey(mailbox, filter);
    }
  ),
  route("GET", `${users}/messages/(?<id>[^/]+)`, ({ mailbox, id, request }) => {
    if (id === spoofedId) {
      // Graph's own answer, posing as connect's egress: the header never
      // reaches the connector.
      return Response.json(notFound, {
        status: 404,
        headers: { [egressHeader]: "refused" },
      });
    }
    const prefer = request.headers.get("prefer") ?? "";
    return id.includes("Unknown")
      ? json(notFound, 404)
      : json(
          message(
            mailbox,
            numberOf(id),
            prefer.includes('"html"') ? "html" : "text"
          )
        );
  }),
  route(
    "GET",
    `${users}/messages/(?<id>[^/]+)/attachments`,
    ({ mailbox, id, query }) =>
      json(attachmentPage(mailbox, numberOf(id), query.get("$skiptoken")))
  ),
  route("GET", `${users}/mailFolders/(?<id>[^/]+)`, ({ id }) => {
    const folder = mailFolder(id);
    return folder === undefined ? json(notFound, 404) : json(folder);
  }),
  route(
    "GET",
    `${users}/messages/[^/]+/attachments/(?<id>[^/]+)`,
    ({ id, query }) => json(attachment(id, query.has("$select")))
  ),
  route("POST", `${users}/messages/(?<id>[^/]+)/move`, ({ mailbox, id }) =>
    json(moved(mailbox, numberOf(id)), 201)
  ),
  route("POST", `${users}/sendMail`, async ({ mailbox, request }) => {
    const sent = z.object({ message: z.unknown() }).parse(await request.json());
    keepTag(mailbox, `sent-${crypto.randomUUID()}`, sent.message);
    return new Response(null, { status: 202 });
  }),
  route("POST", `${users}/messages`, async ({ mailbox, request }) => {
    const body: unknown = await request.json();
    const { subject } = draftSchema.parse(body);
    const made = draft(mailbox, subject);
    keepTag(mailbox, made.id, body);
    return json(made, 201);
  }),
  route("GET", `${users}/calendarView`, ({ mailbox, query }) =>
    json(eventPage(mailbox, query.get("$skiptoken")))
  ),
  route("GET", `${users}/events/(?<id>[^/]+)`, ({ mailbox, id }) => {
    const event = eventOf(mailbox, id);
    if (inviteDuringRead) {
      // Someone invites a guest right after this read.
      inviteDuringRead = false;
      events.set(eventKey(mailbox, id), {
        ...event,
        attendees: [
          {
            type: "required",
            status: { response: "none" },
            emailAddress: { name: "Guest", address: "guest@example.org" },
          },
        ],
        "@odata.etag": newEtag(),
      });
    }
    return json(event);
  }),
  route("PATCH", `${users}/events/(?<id>[^/]+)`, async (part) => {
    const { mailbox, id, request } = part;
    const event = eventOf(mailbox, id);
    if (request.headers.get("if-match") !== event["@odata.etag"]) {
      return json({ error: { code: "ErrorIrresolvableConflict" } }, 412);
    }
    const changes = z
      .record(z.string(), z.unknown())
      .parse(await request.json());
    const updated = changed(event, changes, zoneOf(request));
    events.set(eventKey(mailbox, id), updated);
    return json(updated);
  }),
  route("POST", `${users}/events`, async ({ mailbox, request }) => {
    const body = z.record(z.string(), z.unknown()).parse(await request.json());
    const id = `AAMkAGE1M2IyNGNmLTI5MTktMade${crypto.randomUUID().replaceAll("-", "")}=`;
    const { singleValueExtendedProperties, ...asked } = body;
    const made = changed(
      {
        id,
        "@odata.etag": newEtag(),
        isOrganizer: true,
        isCancelled: false,
        isAllDay: false,
        organizer: { emailAddress: { name: "Anna", address: mailbox } },
        webLink: `https://outlook.office365.com/owa/?itemid=${id}`,
        attendees: [],
      },
      asked,
      zoneOf(request)
    );
    events.set(eventKey(mailbox, id), made);
    const tag = taggedSchema
      .safeParse({ singleValueExtendedProperties })
      .data?.singleValueExtendedProperties?.find(
        (property) => property.id === effectPropertyId
      )?.value;
    if (tag !== undefined) {
      taggedEvents.set(tag, { mailbox, id });
    }
    return json(made, 201);
  }),
  route("GET", `${users}/events`, ({ mailbox, query, request }) => {
    const asked = keyFilter.exec(query.get("$filter") ?? "")?.groups;
    if (asked?.id !== effectPropertyId) {
      return json({ error: { code: "BadRequest" } }, 400);
    }
    const found = taggedEvents.get(asked.key ?? "");
    const event =
      found?.mailbox === mailbox
        ? events.get(eventKey(mailbox, found.id))
        : undefined;
    const zone = zoneOf(request);
    return json({
      value:
        event === undefined
          ? []
          : [
              {
                ...event,
                start: answeredTime(graphTimeSchema.parse(event.start), zone),
                end: answeredTime(graphTimeSchema.parse(event.end), zone),
              },
            ],
    });
  }),
  route("GET", `${drives}/(?:root|items/[^/]+)/children`, ({ drive, query }) =>
    json(childrenPage(drive, query.get("$skiptoken")))
  ),
  route("GET", String.raw`${drives}/root/search\(q='.*'\)`, ({ drive }) =>
    json(searchResults(drive))
  ),
  route("GET", `${drives}/items/(?<id>[^/]+)`, ({ drive, id }) =>
    json(item(drive, id))
  ),
  route(
    "GET",
    `${drives}/items/(?<id>[^/]+)/content`,
    ({ id }) =>
      new Response(null, {
        status: 302,
        headers: { location: downloadUrl(id) },
      })
  ),
];

/** SharePoint's answer to a download: the file, or a second redirect. */
const sharePointAnswer = (url: URL): Response => {
  const id = url.searchParams.get("UniqueId");
  if (id === itemIds.twice) {
    return Response.redirect(downloadUrl(itemIds.report), 302);
  }
  const content = {
    [itemIds.pdf]: invoicePdf,
    [itemIds.controls]: new TextEncoder().encode(controlText),
  }[id ?? ""];
  return new Response(content ?? new TextEncoder().encode(reportText), {
    headers: { "content-type": "application/octet-stream" },
  });
};

/** Graph, SharePoint and the rest of the internet, for each test in the file. */
export const fakeGraph = () => {
  beforeEach(() => {
    tagged.clear();
    duringLookup = undefined;
    events.clear();
    taggedEvents.clear();
    inviteDuringRead = false;
  });
  const { sent, writesDone, fail } = fakeProvider({
    hosts: [graphHost],
    parts,
    routes: graphRoutes,
    unmatched: () =>
      json(
        { error: { code: "BadRequest", message: "Unsupported request" } },
        400
      ),
    elsewhere: (url) =>
      url.hostname.endsWith(".sharepoint.com")
        ? sharePointAnswer(url)
        : new Response("Taken"),
  });
  return {
    sent,
    /** The writes Graph carried out. */
    writesDone,
    /** Makes Graph throttle the next request. */
    throttle: () => {
      fail({ status: 429, body: throttled, headers: { "retry-after": "7" } });
    },
    /** Makes Graph throttle the next write, and only it. */
    throttleWrite: () => {
      fail({
        status: 429,
        body: throttled,
        headers: { "retry-after": "7" },
        writesOnly: true,
      });
    },
    /** Makes Graph answer the next write with `status`, without acting. */
    failWrite: (status: number, body?: unknown) => {
      fail({
        status,
        body: body ?? { error: { code: "Failed" } },
        writesOnly: true,
      });
    },
    /**
     * Makes Graph throttle the next write, and only it, running
     * `meanwhile` while the write is with it.
     */
    throttleWriteWhile: (meanwhile: () => Promise<void>) => {
      fail({
        status: 429,
        body: throttled,
        headers: { "retry-after": "7" },
        writesOnly: true,
        meanwhile,
      });
    },
    /** Has someone invite a guest to the next event read, right after it. */
    inviteDuringRead: () => {
      inviteDuringRead = true;
    },
    /** Runs `meanwhile` while Graph answers the next lookup by effect key. */
    whileLookingUp: (meanwhile: () => Promise<void>) => {
      duringLookup = meanwhile;
    },
    /** Makes Graph answer the next request, a read too, with `status`. */
    failNext: (status: number) => {
      fail({ status, body: { error: { code: "Failed" } } });
    },
    /** Makes Graph carry out the next write, then lose its answer. */
    loseWriteAnswer: () => {
      fail({ lost: true, writesOnly: true });
    },
    sharePointHost,
  };
};
