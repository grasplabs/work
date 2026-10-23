/**
 * Microsoft Graph and the tenant's SharePoint, as the Microsoft 365
 * connector reaches them through connect's egress, serving the recorded
 * answers in test/fixtures/graph.ts. Any other host takes whatever it is
 * sent, as an attacker's would. `throttle` makes Graph answer the next
 * request with a 429, `throttleWrite` the next write; `failWrite` answers
 * the next write with an error, and `loseWriteAnswer` carries the next
 * write out and loses its answer. Each person's To Do is theirs alone:
 * Graph answers a token for its own user's lists only, as it answers a
 * delegated `Tasks.ReadWrite` token.
 */
import { egressHeader } from "@grasp-os/connector-kit/manifest";
import {
  effectPropertyId,
  graphHost,
} from "@grasp-os/connector-microsoft-365/graph";
import { beforeEach } from "vite-plus/test";
import { z } from "zod";

import {
  accessDenied,
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
  todoLists,
} from "./fixtures/graph.ts";
import { fakeProvider, json, route as routeOn } from "./internet.ts";
import type { ProviderRoute } from "./internet.ts";
import type { fakeProviders } from "./oauth-provider.ts";

const users = String.raw`^/v1\.0/users/(?<mailbox>[^/]+)`;
const drives = String.raw`^/v1\.0/drives/(?<drive>[^/]+)`;

const parts = ["mailbox", "drive", "id", "list", "task"] as const;

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

/** A task in someone's To Do, as Graph keeps it. */
interface TodoTask {
  id: string;
  title: string;
  status: string;
  body: { contentType: string; content: string };
  dueDateTime?: { dateTime: string; timeZone: string };
  completedDateTime?: { dateTime: string; timeZone: string };
  createdDateTime: string;
  lastModifiedDateTime: string;
  /** The effect key it was tagged with, if any. */
  tag?: string;
}

const todoTaskSchema = z.object({
  title: z.string(),
  body: z.object({ contentType: z.string(), content: z.string() }).optional(),
  dueDateTime: z
    .object({ dateTime: z.string(), timeZone: z.string() })
    .optional(),
});

/**
 * Each person's To Do tasks, by their account's subject and the list.
 * Cleared before each test.
 */
const todoTasks = new Map<string, TodoTask[]>();

const tasksOf = (owner: string, list: string): TodoTask[] => {
  const key = `${owner} ${list}`;
  const tasks = todoTasks.get(key) ?? [];
  todoTasks.set(key, tasks);
  return tasks;
};

/** A task as Graph answers for it, without the tag it keeps. */
const taskAnswer = ({ tag: _tag, ...task }: TodoTask) => ({
  "@odata.etag": `W/"${task.id}"`,
  importance: "normal",
  isReminderOn: false,
  ...task,
});

/** The `$expand` that reads a task's effect tag, as Graph documents it. */
const tagExpansion = `singleValueExtendedProperties($filter=id eq '${effectPropertyId}')`;

/**
 * Graph pages a list's tasks with their tag expanded by two, fewer than a
 * lookup asks for, as Graph may: a lookup must follow the next page.
 */
const taggedTaskPageSize = 2;

/** A page of tasks with their effect tag expanded, from `$skip`. */
const taggedTaskPage = (tasks: TodoTask[], skip: string | null) => {
  const from = Number(skip ?? "0");
  const to = from + taggedTaskPageSize;
  return {
    value: tasks.slice(from, to).map((task) => ({
      ...taskAnswer(task),
      ...(task.tag === undefined
        ? {}
        : {
            singleValueExtendedProperties: [
              { id: effectPropertyId, value: task.tag },
            ],
          }),
    })),
    ...(to < tasks.length
      ? {
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/todo/lists/tasks?%24skip=${to}`,
        }
      : {}),
  };
};

/** The effect key a task Graph is asked to make is tagged with, if any. */
const tagOf = (made: unknown): string | undefined =>
  taggedSchema
    .safeParse(made)
    .data?.singleValueExtendedProperties?.find(
      (property) => property.id === effectPropertyId
    )?.value;

/** The person's own lists they shared during a test. Cleared before each. */
const sharedSince = new Set<string>();

/** The To Do list with this id, if Graph has one. */
const listOf = (id: string) => {
  const list = todoLists.find((each) => each.id === id);
  return list !== undefined && sharedSince.has(id)
    ? { ...list, isShared: true }
    : list;
};

/**
 * Graph's To Do routes. `ownerOf` says whose a request's token is, if the
 * mailbox it names is that user: anyone else's To Do is refused.
 */
const todoRoutes = (
  ownerOf: (mailbox: string, request: Request) => string | undefined
): ProviderRoute<Part>[] => {
  const lists = `${users}/todo/lists`;
  /** The list's owner, or Graph's refusal. */
  const opened = (
    mailbox: string,
    list: string,
    request: Request
  ): string | Response => {
    const owner = ownerOf(mailbox, request);
    if (owner === undefined) {
      return json(accessDenied, 403);
    }
    return listOf(list) === undefined ? json(notFound, 404) : owner;
  };
  return [
    route("GET", lists, ({ mailbox, request }) =>
      ownerOf(mailbox, request) === undefined
        ? json(accessDenied, 403)
        : json({ value: todoLists.map(({ id }) => listOf(id)) })
    ),
    route("GET", `${lists}/(?<list>[^/]+)`, ({ mailbox, list, request }) => {
      const owner = opened(mailbox, list, request);
      return owner instanceof Response ? owner : json(listOf(list));
    }),
    route(
      "GET",
      `${lists}/(?<list>[^/]+)/tasks`,
      ({ mailbox, list, query, request }) => {
        const owner = opened(mailbox, list, request);
        if (owner instanceof Response) {
          return owner;
        }
        const tasks = tasksOf(owner, list);
        const filter = query.get("$filter") ?? "";
        // To Do refuses the extended property filter mail and events take.
        if (filter.startsWith("singleValueExtendedProperties/")) {
          return json({ error: { code: "Request_UnsupportedQuery" } }, 400);
        }
        const expand = query.get("$expand");
        if (expand !== null) {
          if (expand !== tagExpansion) {
            return json({ error: { code: "BadRequest" } }, 400);
          }
          return json(taggedTaskPage(tasks, query.get("$skip")));
        }
        const openOnly = filter === "status ne 'completed'";
        return json({
          value: tasks
            .filter(({ status }) => !openOnly || status !== "completed")
            .map(taskAnswer),
        });
      }
    ),
    route(
      "POST",
      `${lists}/(?<list>[^/]+)/tasks`,
      async ({ mailbox, list, request }) => {
        const owner = opened(mailbox, list, request);
        if (owner instanceof Response) {
          return owner;
        }
        const body: unknown = await request.json();
        const { title, body: note, dueDateTime } = todoTaskSchema.parse(body);
        const now = new Date().toISOString();
        const task: TodoTask = {
          id: `AAkALgAAAAAAHYQDEapmEc2byACqAC-EWg0A${crypto.randomUUID().replaceAll("-", "")}=`,
          title,
          status: "notStarted",
          body: note ?? { contentType: "text", content: "" },
          ...(dueDateTime === undefined ? {} : { dueDateTime }),
          createdDateTime: now,
          lastModifiedDateTime: now,
        };
        const tag = tagOf(body);
        tasksOf(owner, list).push({
          ...task,
          ...(tag === undefined ? {} : { tag }),
        });
        return json(taskAnswer(task), 201);
      }
    ),
    route(
      "PATCH",
      `${lists}/(?<list>[^/]+)/tasks/(?<task>[^/]+)`,
      async ({ mailbox, list, task: id, request }) => {
        const owner = opened(mailbox, list, request);
        if (owner instanceof Response) {
          return owner;
        }
        const task = tasksOf(owner, list).find((each) => each.id === id);
        if (task === undefined) {
          return json(notFound, 404);
        }
        const { status } = z
          .object({ status: z.string() })
          .parse(await request.json());
        const now = new Date().toISOString();
        task.status = status;
        task.lastModifiedDateTime = now;
        if (status === "completed") {
          task.completedDateTime = {
            dateTime: now.replace("Z", ""),
            timeZone: "UTC",
          };
        }
        return json(taskAnswer(task));
      }
    ),
  ];
};

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

/**
 * Graph, SharePoint and the rest of the internet, for each test in the
 * file. Given the OAuth providers, Graph knows whose each token is, and
 * opens a person's To Do to their own token only; without them, it opens
 * no one's.
 */
export const fakeGraph = (providers?: ReturnType<typeof fakeProviders>) => {
  beforeEach(() => {
    tagged.clear();
    todoTasks.clear();
    sharedSince.clear();
    duringLookup = undefined;
  });
  /** The subject of the token's account, if `mailbox` is that account. */
  const ownerOf = (mailbox: string, request: Request): string | undefined => {
    const token = (request.headers.get("authorization") ?? "").replace(
      "Bearer ",
      ""
    );
    const account = providers?.state.holders.get(token);
    if (account === undefined) {
      return undefined;
    }
    const isThem =
      mailbox.toLowerCase() === account.email.toLowerCase() ||
      mailbox === account.subject;
    return isThem ? account.subject : undefined;
  };
  const { sent, writesDone, fail } = fakeProvider({
    hosts: [graphHost],
    parts,
    routes: [...graphRoutes, ...todoRoutes(ownerOf)],
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
    /** The person shares their own To Do list `id` with someone. */
    shareList: (id: string) => {
      sharedSince.add(id);
    },
    sharePointHost,
  };
};
