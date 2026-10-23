import { defineTool, ToolError } from "@grasp-os/connector-kit/connector";
import { jsonBody, segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  atPage,
  effectPropertyId,
  graphHost,
  graphJson,
  graphUrl,
  idSchema,
  mailboxSchema,
  nextPageOf,
  pageOf,
  pageSchema,
  topSchema,
  v1,
} from "./graph.ts";

// Microsoft To Do, of one person per call, as `/users/{mailbox}` like mail
// and calendars, so a call's capability binds every request to them. These
// tools reach only the person's own: Graph lets a delegated token
// (`Tasks.ReadWrite`) into the signed-in user's To Do and no one else's,
// and a list someone shared with them, or they shared with others, is
// refused here, so a task is never read, made or completed where another
// person sees it.

const users = `${v1}/users/{mailbox}`;

const get = (path: string) =>
  ({ method: "GET", host: graphHost, path: `${users}${path}` }) as const;

const graphList = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  isOwner: z.boolean().nullish(),
  isShared: z.boolean().nullish(),
  wellknownListName: z.string().nullish(),
});
type GraphList = z.infer<typeof graphList>;

const graphTime = z.object({ dateTime: z.string(), timeZone: z.string() });

const graphTask = z.object({
  id: z.string(),
  title: z.string().nullish(),
  status: z.string().nullish(),
  importance: z.string().nullish(),
  dueDateTime: graphTime.nullish(),
  completedDateTime: graphTime.nullish(),
  createdDateTime: z.string().nullish(),
  lastModifiedDateTime: z.string().nullish(),
});
type GraphTask = z.infer<typeof graphTask>;

const taskFields = [
  "id",
  "title",
  "status",
  "importance",
  "dueDateTime",
  "completedDateTime",
  "createdDateTime",
  "lastModifiedDateTime",
].join(",");

/** Whether a list is the person's alone: theirs, and shared with no one. */
const isOwn = (list: GraphList): boolean =>
  list.isOwner === true && list.isShared !== true;

const listSchema = z.strictObject({
  id: z.string(),
  name: z.string().nullable(),
  wellknownName: z.string().nullable(),
});

const timeSchema = z.strictObject({
  dateTime: z.string(),
  timeZone: z.string(),
});

const taskSchema = z.strictObject({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  importance: z.string().nullable(),
  due: timeSchema.nullable(),
  completedAt: timeSchema.nullable(),
  createdAt: z.string().nullable(),
  lastModifiedAt: z.string().nullable(),
});

const taskOf = (task: GraphTask): z.infer<typeof taskSchema> => ({
  id: task.id,
  title: task.title ?? null,
  status: task.status ?? null,
  importance: task.importance ?? null,
  due: task.dueDateTime ?? null,
  completedAt: task.completedDateTime ?? null,
  createdAt: task.createdDateTime ?? null,
  lastModifiedAt: task.lastModifiedDateTime ?? null,
});

/**
 * The person's list `list`, once Graph says it is theirs alone; a
 * ToolError otherwise. Every tool on a list asks this first, a read
 * before its one write.
 */
const ownList = async (mailbox: string, list: string): Promise<GraphList> => {
  const found = await graphJson(
    graphUrl(`/users/${segment(mailbox)}/todo/lists/${segment(list)}`),
    graphList
  );
  if (!isOwn(found)) {
    throw new ToolError(
      "This To Do list is shared, so it isn't only the person's own",
      { code: "access_denied" }
    );
  }
  return found;
};

const tasksPath = (mailbox: string, list: string): string =>
  `/users/${segment(mailbox)}/todo/lists/${segment(list)}/tasks`;

const listLists = defineTool({
  name: "todo.lists",
  description:
    "Lists a person's own Microsoft To Do lists, the ones shared with no one; lists shared with or by them are left out.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    top: topSchema,
    page: pageSchema,
  }),
  output: z.strictObject({
    mailbox: z.string(),
    lists: z.array(listSchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  reach: "own",
  resource: "mailbox",
  routes: [get("/todo/lists")],
  run: async ({ mailbox, top, page }) => {
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      atPage(
        graphUrl(`/users/${segment(mailbox)}/todo/lists`, {
          $top: String(top ?? 25),
        }),
        page
      ),
      pageOf(graphList)
    );
    const own = value.filter(isOwn);
    return {
      output: {
        mailbox,
        lists: own.map((list) => ({
          id: list.id,
          name: list.displayName ?? null,
          wellknownName: list.wellknownListName ?? null,
        })),
        nextPage: nextPageOf(nextLink),
      },
      provenance: own.map(({ id }) => id),
    };
  },
});

const listTasks = defineTool({
  name: "todo.tasks",
  description:
    "Lists the tasks of one of a person's own Microsoft To Do lists, optionally only those not completed yet.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    list: idSchema,
    openOnly: z.boolean().optional(),
    top: topSchema,
    page: pageSchema,
  }),
  output: z.strictObject({
    mailbox: z.string(),
    listId: z.string(),
    tasks: z.array(taskSchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  reach: "own",
  resource: "mailbox",
  routes: [get("/todo/lists/{list}"), get("/todo/lists/{list}/tasks")],
  run: async ({ mailbox, list, openOnly, top, page }) => {
    await ownList(mailbox, list);
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      atPage(
        graphUrl(tasksPath(mailbox, list), {
          $select: taskFields,
          $top: String(top ?? 25),
          $filter: openOnly === true ? "status ne 'completed'" : undefined,
        }),
        page
      ),
      pageOf(graphTask)
    );
    return {
      output: {
        mailbox,
        listId: list,
        tasks: value.map(taskOf),
        nextPage: nextPageOf(nextLink),
      },
      provenance: value.map(({ id }) => id),
    };
  },
});

const createOutput = z.strictObject({
  mailbox: z.string(),
  listId: z.string(),
  task: taskSchema,
});

/** A task with the effect tag it carries, if Graph expanded it. */
const graphTaggedTask = graphTask.extend({
  singleValueExtendedProperties: z
    .array(z.object({ id: z.string(), value: z.string().nullish() }))
    .nullish(),
});

/** Tasks Graph is asked for per page while a lost task is looked for. */
const effectPageSize = 50;

/**
 * Pages of a list looked through for a lost task before giving up: on a
 * longer list the call's outcome stays unknown rather than risk making a
 * second task.
 */
const effectPages = 40;

/**
 * The task in the person's list that a call with effect key `key` made, if
 * there is one. Graph reads a To Do task's extended property only by
 * expanding it (the `singleValueExtendedProperties/Any(...)` filter that
 * mail and events take is reported as an unsupported query on To Do), so
 * the list is read a page at a time with the tag expanded, and matched
 * here.
 */
const findByEffect = async (
  mailbox: string,
  list: string,
  key: string
): Promise<GraphTask | undefined> => {
  let page: string | undefined;
  for (let pages = 0; pages < effectPages; pages += 1) {
    // One page after another: each names the next.
    // oxlint-disable-next-line no-await-in-loop -- sequential pages
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      atPage(
        graphUrl(tasksPath(mailbox, list), {
          $select: taskFields,
          $top: String(effectPageSize),
          $expand: `singleValueExtendedProperties($filter=id eq '${effectPropertyId}')`,
        }),
        page
      ),
      pageOf(graphTaggedTask)
    );
    const found = value.find(
      (task) =>
        task.singleValueExtendedProperties?.some(
          (property) => property.value === key
        ) === true
    );
    const next = nextPageOf(nextLink);
    if (found !== undefined || next === null) {
      return found;
    }
    page = next;
  }
  throw new ToolError(
    "This To Do list is too long to look through for the task",
    { code: "failed" }
  );
};

const createTask = defineTool({
  name: "todo.create",
  description:
    "Adds a task, such as a follow-up someone promised, to one of a person's own Microsoft To Do lists, with a note and a due day if given.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    list: idSchema,
    title: z.string().min(1).max(255),
    note: z
      .string()
      .max(32 * 1024)
      .optional(),
    due: z.iso.date().optional(),
  }),
  output: createOutput,
  readOnly: false,
  reach: "own",
  destructive: false,
  resource: "mailbox",
  routes: [
    get("/todo/lists/{list}"),
    get("/todo/lists/{list}/tasks"),
    {
      method: "POST",
      host: graphHost,
      path: `${users}/todo/lists/{list}/tasks`,
    },
  ],
  describe: {
    title: "Add a task to Microsoft To Do",
    fields: [
      { label: "For", input: "mailbox" },
      { label: "List", input: "list" },
      { label: "Title", input: "title" },
      { label: "Due", input: "due" },
      { label: "Note", input: "note" },
    ],
  },
  run: async ({ mailbox, list, title, note, due }, { key: effectKey }) => {
    await ownList(mailbox, list);
    const task = await graphJson(
      graphUrl(tasksPath(mailbox, list)),
      graphTask,
      jsonBody({
        title,
        ...(note === undefined
          ? {}
          : { body: { contentType: "text", content: note } }),
        // To Do keeps a due day as a time: noon UTC falls on that day in
        // every time zone from UTC-12 to UTC+11, wherever the person is.
        ...(due === undefined
          ? {}
          : { dueDateTime: { dateTime: `${due}T12:00:00`, timeZone: "UTC" } }),
        ...(effectKey === null
          ? {}
          : {
              singleValueExtendedProperties: [
                { id: effectPropertyId, value: effectKey },
              ],
            }),
      })
    );
    return { output: { mailbox, listId: list, task: taskOf(task) } };
  },
  // Made, if a task with its key is in the list.
  find: async ({ mailbox, list }, effect) => {
    const task = await findByEffect(mailbox, list, effect.key);
    return task === undefined
      ? null
      : { output: { mailbox, listId: list, task: taskOf(task) } };
  },
});

const completeTask = defineTool({
  name: "todo.complete",
  description:
    "Marks a task in one of a person's own Microsoft To Do lists as completed.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    list: idSchema,
    task: idSchema,
  }),
  output: z.strictObject({
    mailbox: z.string(),
    listId: z.string(),
    task: taskSchema,
  }),
  readOnly: false,
  reach: "own",
  destructive: false,
  resource: "mailbox",
  routes: [
    get("/todo/lists/{list}"),
    {
      method: "PATCH",
      host: graphHost,
      path: `${users}/todo/lists/{list}/tasks/{task}`,
    },
  ],
  describe: {
    title: "Complete a task in Microsoft To Do",
    fields: [
      { label: "For", input: "mailbox" },
      { label: "List", input: "list" },
      { label: "Task", input: "task" },
    ],
  },
  // Completing sets a state, so a call of unknown outcome is sent again.
  repeatable: true,
  run: async ({ mailbox, list, task: id }) => {
    await ownList(mailbox, list);
    const task = await graphJson(
      graphUrl(`${tasksPath(mailbox, list)}/${segment(id)}`),
      graphTask,
      { ...jsonBody({ status: "completed" }), method: "PATCH" }
    );
    return { output: { mailbox, listId: list, task: taskOf(task) } };
  },
});

export const todoTools = [listLists, listTasks, createTask, completeTask];
