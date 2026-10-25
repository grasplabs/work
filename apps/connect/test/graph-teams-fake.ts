/**
 * Graph's Teams chats, the person's calendar as a calendar view reads it,
 * their online meetings and the meetings' transcripts, as the Microsoft
 * 365 connector reaches them, beside the rest of the fake Graph
 * (graph-api.ts). A calendar holds the meetings once `holdMeetings` puts
 * them there; graph-api.ts's calendar routes ask `meetingsAnswer` first.
 * Graph answers a token for its own user only, as it
 * answers a delegated `Chat.Read` or `OnlineMeetings.Read` token: anyone
 * else's chats, calendar and meetings are refused. One chat, of two
 * colleagues, answers without the person among its members, as a chat
 * whose ID was read somewhere would if Graph let it through.
 */
import {
  calendarEvents,
  chat,
  chatIds,
  chatMessages,
  financeLead,
  member,
  meetingIds,
  onlineMeetings,
  reviewVtt,
  transcriptIds,
} from "./fixtures/graph-teams.ts";
import { graphAccessDenied, notFound } from "./fixtures/graph.ts";
import type { Part } from "./graph-api.ts";
import { json } from "./internet.ts";
import type { ProviderRoute } from "./internet.ts";

export const teamsParts = ["chat", "event", "meeting", "transcript"] as const;

type Route = (
  method: string,
  path: string,
  answer: ProviderRoute<Part>["answer"]
) => ProviderRoute<Part>;

const users = String.raw`^/v1\.0/users/(?<mailbox>[^/]+)`;

/** The mailboxes whose calendar holds the meetings. Cleared before each test. */
const meetingCalendars = new Set<string>();

export const resetTeams = (): void => {
  meetingCalendars.clear();
};

/** Makes `mailbox`'s calendar hold the meetings, in place of the usual events. */
export const holdMeetings = (mailbox: string): void => {
  meetingCalendars.add(mailbox.toLowerCase());
};

/**
 * Graph's answer to a calendar view (no `event`) or an event's read of a
 * calendar holding the meetings, or `undefined` for any other calendar.
 */
export const meetingsAnswer = (
  mailbox: string,
  query: URLSearchParams,
  event?: string
): Response | undefined => {
  if (!meetingCalendars.has(decodeURIComponent(mailbox).toLowerCase())) {
    return undefined;
  }
  if (event !== undefined) {
    const found = calendarEvents.find(
      (each) => each.id === decodeURIComponent(event)
    );
    return found === undefined ? json(notFound, 404) : json(found);
  }
  // A calendar view needs its window.
  if (!(query.has("startDateTime") && query.has("endDateTime"))) {
    return json({ error: { code: "ErrorInvalidParameter" } }, 400);
  }
  return json({ value: calendarEvents });
};

/** A join URL in a `$filter` Graph takes on online meetings. */
const joinUrlFilter = /^JoinWebUrl eq '(?<url>(?:[^']|'')*)'$/u;

/** The person's own chat, they and the finance lead its members. */
const ownChat = (mailbox: string) =>
  chat(chatIds.own, [member("You", mailbox.toLowerCase()), financeLead]);

/**
 * The routes, given how graph-api.ts makes one and whose a request's
 * token is (`ownerOf`: the subject, if the mailbox it names is that user).
 */
export const teamsRoutes = (
  route: Route,
  ownerOf: (mailbox: string, request: Request) => string | undefined
): ProviderRoute<Part>[] => {
  const theirChat = chat(chatIds.theirs, [
    financeLead,
    member("Tom de Vries", "tom.devries@acme.test"),
  ]);
  const chatOf = (mailbox: string, id: string) => {
    if (id === chatIds.own) {
      return ownChat(mailbox);
    }
    return id === chatIds.theirs ? theirChat : undefined;
  };
  const meeting = `${users}/onlineMeetings/(?<meeting>[^/]+)`;
  return [
    route("GET", `${users}/chats`, ({ mailbox, request }) =>
      ownerOf(mailbox, request) === undefined
        ? json(graphAccessDenied, 403)
        : json({ value: [ownChat(mailbox)] })
    ),
    route(
      "GET",
      `${users}/chats/(?<chat>[^/]+)`,
      ({ mailbox, chat: id, request }) => {
        if (ownerOf(mailbox, request) === undefined) {
          return json(graphAccessDenied, 403);
        }
        const found = chatOf(mailbox, decodeURIComponent(id));
        return found === undefined ? json(notFound, 404) : json(found);
      }
    ),
    route(
      "GET",
      `${users}/chats/(?<chat>[^/]+)/messages`,
      ({ mailbox, chat: id, request }) => {
        if (ownerOf(mailbox, request) === undefined) {
          return json(graphAccessDenied, 403);
        }
        return chatOf(mailbox, decodeURIComponent(id)) === undefined
          ? json(notFound, 404)
          : json({ value: chatMessages });
      }
    ),
    route("GET", `${users}/onlineMeetings`, ({ mailbox, query, request }) => {
      if (ownerOf(mailbox, request) === undefined) {
        return json(graphAccessDenied, 403);
      }
      const url = joinUrlFilter
        .exec(query.get("$filter") ?? "")
        ?.groups?.url?.replaceAll("''", "'");
      // Graph lists online meetings only by a join URL, or a meeting ID.
      if (url === undefined) {
        return json({ error: { code: "BadRequest" } }, 400);
      }
      const found = onlineMeetings.get(url);
      return json({ value: found === undefined ? [] : [found] });
    }),
    route(
      "GET",
      `${meeting}/transcripts`,
      ({ mailbox, meeting: id, request }) => {
        if (ownerOf(mailbox, request) === undefined) {
          return json(graphAccessDenied, 403);
        }
        return json({
          value:
            id === meetingIds.review
              ? [
                  {
                    id: transcriptIds.review,
                    meetingId: id,
                    createdDateTime: "2026-10-21T09:46:12.000Z",
                  },
                ]
              : [],
        });
      }
    ),
    route(
      "GET",
      `${meeting}/transcripts/(?<transcript>[^/]+)/content`,
      ({ mailbox, meeting: id, transcript, query, request }) => {
        if (ownerOf(mailbox, request) === undefined) {
          return json(graphAccessDenied, 403);
        }
        if (id !== meetingIds.review || transcript !== transcriptIds.review) {
          return json(notFound, 404);
        }
        // Without `$format=text/vtt` Graph answers in Word's format.
        if (query.get("$format") !== "text/vtt") {
          return json({ error: { code: "BadRequest" } }, 400);
        }
        return new Response(reviewVtt, {
          headers: { "content-type": "text/vtt" },
        });
      }
    ),
  ];
};
