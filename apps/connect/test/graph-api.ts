/**
 * Microsoft Graph and the tenant's SharePoint, as the Microsoft 365
 * connector reaches them through connect's egress, serving the recorded
 * answers in test/fixtures/graph.ts. Any other host takes whatever it is
 * sent, as an attacker's would. `throttle` makes Graph answer the next
 * request with a 429, `throttleWrite` the next write; `failWrite` answers
 * the next write with an error, and `loseWriteAnswer` carries the next
 * write out and loses its answer.
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
    ({ mailbox, query }) => {
      const filter = query.get("$filter") ?? "";
      return filter.startsWith("singleValueExtendedProperties/")
        ? foundByKey(mailbox, filter)
        : json(messagePage(mailbox, Number(query.get("$skip") ?? 0)));
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
  route("GET", `${users}/events/(?<id>[^/]+)`, ({ mailbox, id }) =>
    json(eventDetail(mailbox, numberOf(id)))
  ),
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
