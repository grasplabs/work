import {
  apisHost,
  gmailHost,
} from "@grasp-os/connector-google-workspace/google";
/**
 * Gmail, Calendar and Drive, as the Google Workspace connector reaches
 * them through connect's egress, serving the recorded answers in
 * test/fixtures/google.ts. Any other host takes whatever it is sent, as an
 * attacker's would. `rateLimit403` makes Google refuse the next request as
 * Drive and Calendar do when they rate limit.
 */
import { egressHeader } from "@grasp-os/connector-kit/manifest";
import { beforeEach } from "vite-plus/test";
import { z } from "zod";

import {
  allDayEvent,
  attachmentBody,
  bodyAttachment,
  cancelledOccurrence,
  cancelledOccurrenceId,
  contentOf,
  detachedBody,
  detachedMessageFull,
  draftId,
  eventDetail,
  eventPage,
  filePage,
  files,
  googleError,
  labelled,
  htmlBody,
  incompleteEvent,
  incompleteEventId,
  labels,
  messageFull,
  messageList,
  messageId,
  messageMetadata,
  notFound,
  overLimitAttachment,
  plainBody,
  searchResults,
  sentId,
} from "./fixtures/google.ts";
import { fakeProvider, json, route } from "./internet.ts";
import type { ProviderRoute } from "./internet.ts";

const users = String.raw`^/gmail/v1/users/(?<mailbox>[^/]+)`;
const calendars = String.raw`^/calendar/v3/calendars/(?<calendar>[^/]+)`;

const parts = ["mailbox", "calendar", "message", "id"] as const;

type Part = (typeof parts)[number];

/** The number of a message or event ID of the fixtures. */
const numberOf = (id: string): number => Number(id.at(-1)) || 1;

const modifySchema = z.object({
  addLabelIds: z.array(z.string()),
  removeLabelIds: z.array(z.string()),
});

/** A message listed, but deleted before its read. */
export const deletedMessageId = "19a0f00df00df00d";

/** A message whose read Google answers posing as connect's egress. */
export const spoofedMessageId = "19a0ffffffffffff";

/** An event as Calendar's insert takes it, as far as the fake reads it. */
const newEventSchema = z
  .object({
    id: z.string().optional(),
    summary: z.string(),
    start: z.object({ dateTime: z.string(), timeZone: z.string() }),
    end: z.object({ dateTime: z.string(), timeZone: z.string() }),
  })
  .loose();

/** A file Drive made for this app, with its text. */
interface MadeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  text: string | null;
}

/** A file Drive made, as it answers with it. */
const fileAnswer = ({ id, name, mimeType }: MadeFile) => ({
  id,
  name,
  mimeType,
  webViewLink: `https://docs.google.com/document/d/${id}/edit`,
});

/** The access token a request carries. */
const tokenOf = (request: Request): string =>
  (request.headers.get("authorization") ?? "").replace(/^Bearer /u, "");

/**
 * `holderOf` names the address of the person an access token was issued
 * to: their own calendar is their primary one, as Google lists it for
 * them.
 */
export const fakeGoogle = (holderOf: (token: string) => string | undefined) => {
  /** The attachment IDs each message's reads gave out, and their content. */
  const attachments = new Map<string, { size: number; data: string }>();
  /** The events Calendar's insert made, by calendar and ID. */
  const made = new Map<string, Record<string, unknown>>();
  /** The files Drive made for this app, with their text, in order. */
  const madeFiles: MadeFile[] = [];

  const routes: ProviderRoute<Part>[] = [
    // A search for `deleted` finds more than asked for, one deleted since.
    route(gmailHost, "GET", `${users}/messages`, ({ mailbox, query }) =>
      query.get("q") === "deleted"
        ? json({
            messages: [
              messageId(mailbox, 1),
              deletedMessageId,
              messageId(mailbox, 2),
            ].map((id) => ({ id, threadId: id })),
          })
        : json(messageList(mailbox, query.get("pageToken")))
    ),
    route(gmailHost, "GET", `${users}/messages/(?<id>[^/]+)`, (asked) => {
      const { mailbox, id, query } = asked;
      if (id === spoofedMessageId) {
        return Response.json(notFound, {
          status: 404,
          headers: { [egressHeader]: "refused" },
        });
      }
      if (id.includes("f00d")) {
        return json(notFound, 404);
      }
      if (query.get("format") === "metadata") {
        return json(messageMetadata(mailbox, numberOf(id)));
      }
      // Each read gives the attachments new IDs, as Gmail's do.
      const attachmentId = `ANGjdJ_${crypto.randomUUID().replaceAll("-", "")}`;
      attachments.set(`${id}/${attachmentId}`, attachmentBody);
      attachments.set(`${id}/${attachmentId}text`, bodyAttachment(plainBody));
      attachments.set(`${id}/${attachmentId}html`, bodyAttachment(htmlBody));
      const n = numberOf(id);
      if (n === detachedBody.understated) {
        attachments.set(`${id}/${attachmentId}huge`, overLimitAttachment);
      }
      return json(
        Object.values(detachedBody).some((each) => each === n)
          ? detachedMessageFull(mailbox, n, attachmentId)
          : messageFull(mailbox, n, attachmentId)
      );
    }),
    route(
      gmailHost,
      "GET",
      `${users}/messages/(?<message>[^/]+)/attachments/(?<id>[^/]+)`,
      ({ message, id }) => {
        const found = attachments.get(`${message}/${id}`);
        return found === undefined
          ? json(googleError(400, "INVALID_ARGUMENT", "invalidArgument"), 400)
          : json(found);
      }
    ),
    route(gmailHost, "GET", `${users}/labels`, () => json(labels)),
    route(
      gmailHost,
      "POST",
      `${users}/messages/(?<id>[^/]+)/modify`,
      async ({ mailbox, id, request }) => {
        const { addLabelIds, removeLabelIds } = modifySchema.parse(
          await request.json()
        );
        const before = messageMetadata(mailbox, numberOf(id)).labelIds;
        return json(
          labelled(mailbox, id, [
            ...new Set([
              ...before.filter((label) => !removeLabelIds.includes(label)),
              ...addLabelIds,
            ]),
          ])
        );
      }
    ),
    route(gmailHost, "POST", `${users}/messages/send`, ({ mailbox }) =>
      json(labelled(mailbox, sentId(mailbox), ["SENT"]))
    ),
    route(gmailHost, "POST", `${users}/drafts`, ({ mailbox }) =>
      json({
        id: draftId,
        message: labelled(mailbox, sentId(mailbox), ["DRAFT"]),
      })
    ),
    // The person's own entry for a calendar: their primary one, else one
    // shared with them.
    route(
      apisHost,
      "GET",
      String.raw`^/calendar/v3/users/me/calendarList/(?<calendar>[^/]+)`,
      ({ calendar, request }) =>
        json({
          id: calendar,
          accessRole: "owner",
          ...(holderOf(tokenOf(request)) === calendar ? { primary: true } : {}),
        })
    ),
    route(
      apisHost,
      "POST",
      `${calendars}/events`,
      async ({ calendar, query, request }) => {
        const event = newEventSchema.parse(await request.json());
        const id = event.id ?? crypto.randomUUID().replaceAll("-", "");
        if (made.has(`${calendar}/${id}`)) {
          return json(googleError(409, "ALREADY_EXISTS", "duplicate"), 409);
        }
        const stored = {
          ...event,
          id,
          status: "confirmed",
          htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
          organizer: { email: calendar, self: true },
          sendUpdates: query.get("sendUpdates"),
        };
        made.set(`${calendar}/${id}`, stored);
        return json(stored);
      }
    ),
    route(apisHost, "GET", `${calendars}/events`, ({ calendar, query }) =>
      json(eventPage(calendar, query.get("pageToken")))
    ),
    route(
      apisHost,
      "GET",
      `${calendars}/events/(?<id>[^/]+)`,
      ({ calendar, id }) => {
        const madeEvent = made.get(`${calendar}/${id}`);
        if (madeEvent !== undefined) {
          return json(madeEvent);
        }
        if (/^[0-9a-f]{64}$/u.test(id)) {
          return json(notFound, 404);
        }
        if (id === cancelledOccurrenceId(calendar)) {
          return json(cancelledOccurrence(calendar));
        }
        if (id === incompleteEventId(calendar)) {
          return json(incompleteEvent(calendar));
        }
        return json(
          id.endsWith("3")
            ? allDayEvent(calendar)
            : eventDetail(calendar, numberOf(id))
        );
      }
    ),
    route(apisHost, "GET", String.raw`^/drive/v3/files`, ({ query }) => {
      const q = query.get("q") ?? "";
      // This app's own files, by their app property, as Drive finds them.
      const property =
        /appProperties has \{ key='(?<key>\w+)' and value='(?<value>\w+)' \}/u.exec(
          q
        )?.groups;
      if (property !== undefined) {
        return json({
          files: madeFiles
            .filter(
              (file) =>
                file.appProperties[property.key ?? ""] === property.value
            )
            .map(fileAnswer),
        });
      }
      return json(
        q.startsWith("fullText")
          ? searchResults
          : filePage(query.get("pageToken"))
      );
    }),
    // A file uploaded with its metadata: Drive converts text to a Doc.
    route(
      apisHost,
      "POST",
      String.raw`^/upload/drive/v3/files`,
      async ({ request }) => {
        const boundary = /boundary=(?<b>\S+)/u.exec(
          request.headers.get("content-type") ?? ""
        )?.groups?.b;
        const sent = await request.text();
        const sections = sent
          .split(`--${boundary ?? ""}`)
          .slice(1, -1)
          .map((part) => part.split("\r\n\r\n").slice(1).join("\r\n\r\n"));
        const [metadata = "", media = ""] = sections;
        const file = {
          ...z
            .object({
              name: z.string(),
              mimeType: z.string(),
              parents: z.array(z.string()),
              appProperties: z.record(z.string(), z.string()).default({}),
            })
            .parse(JSON.parse(metadata.trimEnd())),
          id: `file-${madeFiles.length + 1}`,
          text: media.replace(/\r\n$/u, ""),
        };
        madeFiles.push(file);
        return json(fileAnswer(file));
      }
    ),
    route(
      apisHost,
      "GET",
      String.raw`^/drive/v3/files/(?<id>[^/]+)`,
      ({ id, query }) => {
        const found = files[id];
        if (found === undefined) {
          return json(notFound, 404);
        }
        if (query.get("alt") === "media") {
          return new Response(contentOf(id, null));
        }
        return json(found);
      }
    ),
    route(
      apisHost,
      "GET",
      String.raw`^/drive/v3/files/(?<id>[^/]+)/export`,
      ({ id, query }) =>
        new Response(contentOf(id, query.get("mimeType")), {
          headers: { "content-type": query.get("mimeType") ?? "" },
        })
    ),
  ];

  beforeEach(() => {
    attachments.clear();
    made.clear();
    madeFiles.length = 0;
  });
  const { sent, writesDone, fail } = fakeProvider({
    hosts: [gmailHost, apisHost],
    parts,
    routes,
    unmatched: () =>
      json(googleError(400, "INVALID_ARGUMENT", "badRequest"), 400),
  });
  return {
    sent,
    /** The events Calendar made, as it keeps them, with `sendUpdates`. */
    made: () => [...made.values()],
    /** The files Drive made for this app, with their text. */
    madeFiles: () => [...madeFiles],
    /** The writes Google carried out. */
    writesDone,
    /** Makes Google refuse the next request as Drive and Calendar rate limit. */
    rateLimit403: () => {
      fail({
        status: 403,
        body: googleError(403, "PERMISSION_DENIED", "userRateLimitExceeded"),
      });
    },
    /** Makes Google answer the next write with `status` and `body`. */
    failNextWrite: (status: number, body: unknown) => {
      fail({ status, body, writesOnly: true });
    },
    /** Makes Google answer the next request with `status` and `body`. */
    failNext: (status: number, body: unknown) => {
      fail({ status, body });
    },
    /** Makes Google carry out the next write, then lose its answer. */
    loseWriteAnswer: () => {
      fail({ lost: true, writesOnly: true });
    },
  };
};
