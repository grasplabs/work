import { page, tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { Api } from "@grasp-os/sdk/connector";

import {
  checkIds,
  effectPropertyId,
  effectTag,
  graphId,
  graphPage,
  next,
  nextOf,
  positionOf,
  top,
} from "./graph-sdk.ts";

// Microsoft To Do, the signed-in person's own: every route is under `/me`,
// so a call reaches no one else's To Do. A list someone shared with them,
// or they shared with others, is refused here, so a task is never read,
// made or changed where another person sees it.

const listsRoute = "/me/todo/lists";
const listRoute = "/me/todo/lists/{list}";
const tasksRoute = "/me/todo/lists/{list}/tasks";
const taskRoute = "/me/todo/lists/{list}/tasks/{task}";

/** A To Do list (Graph's todoTaskList), with whose it is. */
const TodoList = v.object({
  id: v.string(),
  displayName: v.string(),
  isOwner: v.boolean().optional(),
  isShared: v.boolean().optional(),
  wellknownListName: v.string().nullable().optional(),
});

/** Whether a list is the person's alone: theirs, and shared with no one. */
const isOwn = (list: {
  isOwner?: boolean | undefined;
  isShared?: boolean | undefined;
}): boolean => list.isOwner === true && list.isShared !== true;

/** Graph's dateTimeTimeZone. */
const DateTimeTimeZone = v.object({
  dateTime: v.string(),
  timeZone: v.string(),
});

const taskFields = {
  id: v.string(),
  title: v.string(),
  status: v.string(),
  importance: v.string(),
  dueDateTime: DateTimeTimeZone.nullable().optional(),
  completedDateTime: DateTimeTimeZone.nullable().optional(),
  createdDateTime: v.string(),
  lastModifiedDateTime: v.string(),
};

/** A To Do task (Graph's todoTask), narrowed to these fields. */
const Task = v.object(taskFields);

const select = Object.keys(taskFields).join(",");

/** Graph's taskStatus. */
const taskStatus = v.enum([
  "notStarted",
  "inProgress",
  "completed",
  "waitingOnOthers",
  "deferred",
]);

/**
 * Refuses the list unless Graph says it is the person's alone. Every tool
 * on a list asks this first, a read before its one write.
 */
const ownList = async (api: Api, list: string): Promise<void> => {
  const found = await api.get(listRoute, {
    path: { list },
    returns: TodoList,
  });
  if (!isOwn(found)) {
    throw new ToolError(
      "This To Do list is shared, so it isn't only the person's own",
      { code: "access_denied" }
    );
  }
};

/** A task with the effect tag it carries, if Graph expanded it. */
const TaggedTask = v.object({
  ...taskFields,
  singleValueExtendedProperties: v
    .array(
      v.object({ id: v.string(), value: v.string().nullable().optional() })
    )
    .nullable()
    .optional(),
});

/**
 * Graph reads a To Do task's extended property only by expanding it (the
 * `singleValueExtendedProperties/Any(...)` filter mail and events take is
 * an unsupported query on To Do).
 */
const tagExpansion = `singleValueExtendedProperties($filter=id eq '${effectPropertyId}')`;

/** Tasks Graph is asked for per page while a lost task is looked for. */
const effectPageSize = 50;

/**
 * Pages of a list looked through for a lost task before giving up: on a
 * longer list the call's outcome stays unknown rather than risk making a
 * second task.
 */
const effectPages = 40;

/**
 * The task in the list that a call with effect key `key` made, if there
 * is one: the list is read a page at a time with the tag expanded, and
 * matched here.
 */
const findByEffect = async (api: Api, list: string, key: string) => {
  let at: string | undefined;
  for (let pages = 0; pages < effectPages; pages += 1) {
    // One page after another: each names the next.
    // oxlint-disable-next-line no-await-in-loop -- sequential pages
    const answer = await api.get(tasksRoute, {
      path: { list },
      query: {
        $select: select,
        $top: effectPageSize,
        $expand: tagExpansion,
        ...positionOf(at),
      },
      returns: graphPage(TaggedTask),
    });
    const found = answer.value.find(
      ({ singleValueExtendedProperties }) =>
        singleValueExtendedProperties?.some(({ value }) => value === key) ===
        true
    );
    if (found !== undefined) {
      const { singleValueExtendedProperties: _tag, ...task } = found;
      return task;
    }
    const following = nextOf(answer["@odata.nextLink"]);
    if (following === null) {
      return null;
    }
    at = following;
  }
  throw new ToolError(
    "This To Do list is too long to look through for the task",
    { code: "failed" }
  );
};

/** Graph's dateTime: a day and a time, without an offset. */
const dateTimePattern =
  /^(?<day>\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?$/u;

/**
 * Refuses, before anything is sent, a due time that isn't a day and a
 * time of Graph's form, or whose day doesn't exist (30 February).
 */
const checkDue = (due: { dateTime: string } | undefined): void => {
  if (due === undefined) {
    return;
  }
  const day = dateTimePattern.exec(due.dateTime)?.groups?.day;
  if (
    day === undefined ||
    !new Date(`${day}T00:00:00Z`).toISOString().startsWith(day)
  ) {
    throw new ToolError(
      "Invalid input: dueDateTime.dateTime isn't a day and a time, such as 2026-10-30T12:00:00",
      { code: "invalid" }
    );
  }
};

/**
 * The person's own To Do tools, by name: each named from its route
 * (`POST /me/todo/lists/{list}/tasks` is `me.todo.lists.tasks.create`).
 */
export const todoTools = {
  "me.todo.lists.list": tool({
    description:
      "Lists the person's own Microsoft To Do lists, a page at a time. Lists shared with them or by them are left out.",
    readOnly: true,
    reach: "own",
    scopes: ["Tasks.Read"],
    routes: [`GET ${listsRoute}`],
    args: { top, next },
    returns: page(TodoList),
    handler: async (args, api) => {
      const answer = await api.get(listsRoute, {
        query: { $top: args.top ?? 25, ...positionOf(args.next) },
        returns: graphPage(TodoList),
      });
      return {
        items: answer.value.filter(isOwn),
        next: nextOf(answer["@odata.nextLink"]),
      };
    },
  }),
  "me.todo.lists.tasks.list": tool({
    description:
      "Lists the tasks in one of the person's own Microsoft To Do lists, a page at a time, optionally only those with one status. A list shared with them or by them is refused.",
    readOnly: true,
    reach: "own",
    scopes: ["Tasks.Read"],
    routes: [`GET ${tasksRoute}`, `GET ${listRoute}`],
    args: { list: graphId, status: taskStatus.optional(), top, next },
    returns: page(Task),
    handler: async ({ list, status, ...args }, api) => {
      checkIds({ list });
      await ownList(api, list);
      const answer = await api.get(tasksRoute, {
        path: { list },
        query: {
          $select: select,
          $top: args.top ?? 25,
          $filter: status === undefined ? undefined : `status eq '${status}'`,
          ...positionOf(args.next),
        },
        returns: graphPage(Task),
      });
      return { items: answer.value, next: nextOf(answer["@odata.nextLink"]) };
    },
  }),
  "me.todo.lists.tasks.create": tool({
    description:
      "Adds a task to one of the person's own Microsoft To Do lists, such as a follow-up someone promised, with a text body and a due date if given. To Do keeps only the due date: noon UTC (2026-10-30T12:00:00 in UTC) falls on that day in every time zone. A list shared with them or by them is refused.",
    readOnly: false,
    reach: "own",
    scopes: ["Tasks.ReadWrite"],
    routes: [`POST ${tasksRoute}`, `GET ${listRoute}`, `GET ${tasksRoute}`],
    args: {
      list: graphId,
      title: v.string().min(1).max(255),
      body: v.object({ content: v.string().max(32 * 1024) }).optional(),
      dueDateTime: v
        .object({
          dateTime: v.string().max(32),
          timeZone: v.string().min(1).max(64),
        })
        .optional(),
    },
    returns: Task,
    handler: async ({ list, title, body, dueDateTime }, api, call) => {
      checkIds({ list });
      checkDue(dueDateTime);
      await ownList(api, list);
      return await api.post(tasksRoute, {
        path: { list },
        body: {
          title,
          ...(body === undefined
            ? {}
            : { body: { contentType: "text", content: body.content } }),
          ...(dueDateTime === undefined ? {} : { dueDateTime }),
          ...effectTag(call.key),
        },
        returns: Task,
      });
    },
    // Made, if a task with its key is in the list. The list may have been
    // shared since the task was made: then it is read no more than the
    // handler would.
    find: async ({ list }, api, call) => {
      checkIds({ list });
      await ownList(api, list);
      return await findByEffect(api, list, call.key);
    },
  }),
  "me.todo.lists.tasks.update": tool({
    description:
      "Marks a task in one of the person's own Microsoft To Do lists as completed: the only status it sets. A list shared with them or by them is refused.",
    readOnly: false,
    reach: "own",
    scopes: ["Tasks.ReadWrite"],
    routes: [`PATCH ${taskRoute}`, `GET ${listRoute}`],
    args: { list: graphId, task: graphId, status: v.literal("completed") },
    returns: Task,
    // Completing sets a state, so a call of unknown outcome is sent again.
    repeatable: true,
    handler: async ({ list, task, status }, api) => {
      checkIds({ list, task });
      await ownList(api, list);
      return await api.patch(taskRoute, {
        path: { list, task },
        body: { status },
        returns: Task,
      });
    },
  }),
};
