/**
 * Graph's Planner, OneNote and a SharePoint list that is written to, as the
 * Microsoft 365 connector reaches them, beside the rest of the fake Graph
 * (graph-api.ts). Planner opens Finance's plan, not HR's, as it answers for
 * a member of Finance's group. Each person's OneNote is theirs alone:
 * Graph answers a token for its own user's notebooks only, as it answers a
 * delegated `Notes.ReadWrite` token. The suppliers list holds its items in
 * memory and refuses a change sent with an old `If-Match` etag. All of it
 * starts afresh for each test (`resetApps`).
 */
import { z } from "zod";

import {
  meetingPage,
  notebooks,
  planIds,
  plannerTask,
  sectionIds,
  suppliersList,
} from "./fixtures/graph-apps.ts";
import {
  accessDenied,
  financeSite,
  graphAccessDenied,
  notFound,
} from "./fixtures/graph.ts";
import type { Part } from "./graph-api.ts";
import { json } from "./internet.ts";
import type { ProviderRoute } from "./internet.ts";

export const appParts = ["plan", "section", "page", "item"] as const;

type Route = (
  method: string,
  path: string,
  answer: ProviderRoute<Part>["answer"]
) => ProviderRoute<Part>;

const planner = String.raw`^/v1\.0/planner`;
const users = String.raw`^/v1\.0/users/(?<mailbox>[^/]+)`;
const sites = String.raw`^/v1\.0/sites/(?<site>[^/]+)`;

/** Planner pages a plan's tasks by two, as Graph may: a reader follows the next page. */
const plannerPageSize = 2;

/** Each plan's tasks, as Planner keeps them. */
const plannerTasks = new Map<string, Record<string, unknown>[]>();

const tasksOfPlan = (plan: string): Record<string, unknown>[] => {
  const tasks = plannerTasks.get(plan) ?? [
    plannerTask(plan, 1),
    plannerTask(plan, 2),
    plannerTask(plan, 3),
  ];
  plannerTasks.set(plan, tasks);
  return tasks;
};

const newPlannerTask = z.object({
  planId: z.string(),
  title: z.string(),
  dueDateTime: z.string().optional(),
  assignments: z.unknown().optional(),
});

/** A page a person made or keeps in OneNote. */
interface NotePage {
  id: string;
  title: string;
  html: string;
  section: string;
  createdDateTime: string;
}

/** Each person's OneNote pages, by their account's subject. */
const notePages = new Map<string, NotePage[]>();

const pagesOf = (owner: string): NotePage[] => {
  const pages = notePages.get(owner) ?? [
    {
      ...meetingPage,
      section: sectionIds.own,
      createdDateTime: "2026-10-20T09:00:00Z",
    },
  ];
  notePages.set(owner, pages);
  return pages;
};

/** The person's own notebooks they shared during a test. */
const sharedSince = new Set<string>();

const sections = [
  { id: sectionIds.own, displayName: "Meetings", notebook: notebooks.own },
  {
    id: sectionIds.sharedByThem,
    displayName: "Onboarding",
    notebook: notebooks.sharedByThem,
  },
  {
    id: sectionIds.sharedWithThem,
    displayName: "2026",
    notebook: notebooks.sharedWithThem,
  },
];

const notebookOf = (notebook: (typeof sections)[number]["notebook"]) =>
  sharedSince.has(notebook.id) ? { ...notebook, isShared: true } : notebook;

/** A section as Graph answers for it: its notebook only when expanded. */
const sectionAnswer = (
  section: (typeof sections)[number],
  query: URLSearchParams
) => ({
  id: section.id,
  displayName: section.displayName,
  ...((query.get("$expand") ?? "").startsWith("parentNotebook")
    ? { parentNotebook: notebookOf(section.notebook) }
    : {}),
});

const pageAnswer = (page: NotePage, query: URLSearchParams) => {
  const expand = query.get("$expand") ?? "";
  const section = sections.find(({ id }) => id === page.section);
  return {
    id: page.id,
    title: page.title,
    createdDateTime: page.createdDateTime,
    lastModifiedDateTime: page.createdDateTime,
    contentUrl: `https://graph.microsoft.com/v1.0/users('x')/onenote/pages/${page.id}/content`,
    ...(expand.includes("parentNotebook") && section !== undefined
      ? { parentNotebook: notebookOf(section.notebook) }
      : {}),
    ...(expand.includes("parentSection")
      ? { parentSection: { id: page.section } }
      : {}),
  };
};

const titleTag = /<title>(?<title>[^<]*)<\/title>/u;

/** The suppliers list's items, by ID. */
const supplierItems = new Map<
  string,
  { etag: number; fields: Record<string, unknown> }
>();

const seedSuppliers = (): void => {
  supplierItems.clear();
  supplierItems.set("1", {
    etag: 1,
    fields: {
      Title: "Northwind Supplies",
      IBAN: "NL91ABNA0417164300",
      Approved: true,
      CreditLimit: 5000,
      Notes: null,
    },
  });
};

const etagOf = (id: string, version: number): string =>
  `"a5c1f2e4-7b8d-4c3e-9f10-2b6d8e4a1c37,${id}.${version}"`;

/** A supplier item as Graph answers for it, its fields as SharePoint adds to them. */
const supplierAnswer = (
  id: string,
  held: { etag: number; fields: Record<string, unknown> }
) => ({
  "@odata.etag": etagOf(id, held.etag),
  id,
  createdDateTime: "2026-09-01T08:00:00Z",
  lastModifiedDateTime: "2026-10-20T08:00:00Z",
  webUrl: `https://example.sharepoint.com/sites/Finance/Lists/Suppliers/${id}_.000`,
  fields: {
    "@odata.etag": etagOf(id, held.etag),
    id,
    ContentType: "Item",
    _UIVersionString: `1.${held.etag}`,
    Edit: "",
    LinkTitle: held.fields.Title,
    ...held.fields,
  },
});

const fieldsSchema = z.record(z.string(), z.unknown());

/** Starts Planner, OneNote and the suppliers list afresh. */
export const resetApps = (): void => {
  plannerTasks.clear();
  notePages.clear();
  sharedSince.clear();
  seedSuppliers();
};

/**
 * The routes, given how graph-api.ts makes one and whose a request's
 * token is (`ownerOf`: the subject, if the mailbox it names is that user).
 */
export const appRoutes = (
  route: Route,
  ownerOf: (mailbox: string, request: Request) => string | undefined
): ProviderRoute<Part>[] => {
  const onenote = `${users}/onenote`;
  return [
    // Planner.
    route("GET", `${planner}/plans/(?<plan>[^/]+)`, (asked) => {
      const { plan } = asked;
      if (plan === planIds.hr) {
        return json(graphAccessDenied, 403);
      }
      return plan === planIds.finance
        ? json({ id: plan, title: "Month-end close", owner: "group-finance" })
        : json(notFound, 404);
    }),
    route("GET", `${planner}/plans/(?<plan>[^/]+)/tasks`, (asked) => {
      const { plan } = asked;
      if (plan === planIds.hr) {
        return json(graphAccessDenied, 403);
      }
      if (plan !== planIds.finance) {
        return json(notFound, 404);
      }
      const { query } = asked;
      // Planner refuses query options it doesn't take on a plan's tasks.
      if (query.has("$top") || query.has("$filter")) {
        return json({ error: { code: "BadRequest" } }, 400);
      }
      const from = Number(query.get("$skiptoken") ?? 0);
      const tasks = tasksOfPlan(plan);
      const to = from + plannerPageSize;
      return json({
        value: tasks.slice(from, to),
        ...(to < tasks.length
          ? {
              "@odata.nextLink": `https://graph.microsoft.com/v1.0/planner/plans/${plan}/tasks?$skiptoken=${to}`,
            }
          : {}),
      });
    }),
    route("POST", `${planner}/tasks`, async ({ request }) => {
      const body = newPlannerTask.parse(await request.json());
      if (body.planId === planIds.hr) {
        return json(graphAccessDenied, 403);
      }
      if (body.planId !== planIds.finance) {
        return json(notFound, 404);
      }
      const tasks = tasksOfPlan(body.planId);
      const task = plannerTask(body.planId, tasks.length + 1, {
        title: body.title,
        percentComplete: 0,
        completedDateTime: null,
        dueDateTime: body.dueDateTime ?? null,
        createdDateTime: new Date().toISOString(),
        assignments: body.assignments ?? {},
        id: `01gzSlKkIUSUl6DF_Eilrm${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`,
      });
      tasks.push(task);
      return json(task, 201);
    }),
    // OneNote.
    route("GET", `${onenote}/sections`, (asked) => {
      if (ownerOf(asked.mailbox, asked.request) === undefined) {
        return json(graphAccessDenied, 403);
      }
      return json({
        value: sections.map((section) => sectionAnswer(section, asked.query)),
      });
    }),
    route("GET", `${onenote}/sections/(?<section>[^/]+)`, (asked) => {
      if (ownerOf(asked.mailbox, asked.request) === undefined) {
        return json(graphAccessDenied, 403);
      }
      const section = sections.find(({ id }) => id === asked.section);
      return section === undefined
        ? json(notFound, 404)
        : json(sectionAnswer(section, asked.query));
    }),
    route("GET", `${onenote}/sections/(?<section>[^/]+)/pages`, (asked) => {
      const owner = ownerOf(asked.mailbox, asked.request);
      if (owner === undefined) {
        return json(graphAccessDenied, 403);
      }
      const { section } = asked;
      return json({
        value: pagesOf(owner)
          .filter((page) => page.section === section)
          .toReversed()
          .map((page) => pageAnswer(page, new URLSearchParams())),
      });
    }),
    route(
      "POST",
      `${onenote}/sections/(?<section>[^/]+)/pages`,
      async (asked) => {
        const owner = ownerOf(asked.mailbox, asked.request);
        if (owner === undefined) {
          return json(graphAccessDenied, 403);
        }
        const { section } = asked;
        if (!sections.some(({ id }) => id === section)) {
          return json(notFound, 404);
        }
        if (asked.request.headers.get("content-type") !== "text/html") {
          return json({ error: { code: "20110" } }, 400);
        }
        const html = await asked.request.text();
        const page: NotePage = {
          id: `0-${crypto.randomUUID().replaceAll("-", "")}!1-816F7725BBF9E5!2160`,
          title: titleTag.exec(html)?.groups?.title ?? "",
          html,
          section,
          createdDateTime: new Date().toISOString(),
        };
        pagesOf(owner).push(page);
        return json(pageAnswer(page, new URLSearchParams()), 201);
      }
    ),
    route("GET", `${onenote}/pages/(?<page>[^/]+)`, (asked) => {
      const owner = ownerOf(asked.mailbox, asked.request);
      if (owner === undefined) {
        return json(graphAccessDenied, 403);
      }
      const page = pagesOf(owner).find(({ id }) => id === asked.page);
      return page === undefined
        ? json(notFound, 404)
        : json(pageAnswer(page, asked.query));
    }),
    route("GET", `${onenote}/pages/(?<page>[^/]+)/content`, (asked) => {
      const owner = ownerOf(asked.mailbox, asked.request);
      if (owner === undefined) {
        return json(graphAccessDenied, 403);
      }
      const page = pagesOf(owner).find(({ id }) => id === asked.page);
      return page === undefined
        ? json(notFound, 404)
        : new Response(page.html, { headers: { "content-type": "text/html" } });
    }),
    // The suppliers list, which tools write to.
    route(
      "POST",
      `${sites}/lists/(?<list>${suppliersList})/items`,
      async (asked) => {
        if (asked.site !== financeSite) {
          return json(accessDenied, 403);
        }
        const { fields } = z
          .object({ fields: fieldsSchema })
          .parse(await asked.request.json());
        const id = String(supplierItems.size + 1);
        const held = { etag: 1, fields };
        supplierItems.set(id, held);
        return json(supplierAnswer(id, held), 201);
      }
    ),
    route(
      "GET",
      `${sites}/lists/(?<list>${suppliersList})/items/(?<item>[^/]+)`,
      (asked) => {
        const held = supplierItems.get(asked.item);
        return held === undefined
          ? json(notFound, 404)
          : json(supplierAnswer(asked.item, held));
      }
    ),
    route(
      "PATCH",
      `${sites}/lists/(?<list>${suppliersList})/items/(?<item>[^/]+)/fields`,
      async (asked) => {
        const id = asked.item;
        const held = supplierItems.get(id);
        if (held === undefined) {
          return json(notFound, 404);
        }
        const ifMatch = asked.request.headers.get("if-match");
        if (ifMatch !== null && ifMatch !== etagOf(id, held.etag)) {
          return json({ error: { code: "resourceModified" } }, 412);
        }
        const changes = fieldsSchema.parse(await asked.request.json());
        held.fields = { ...held.fields, ...changes };
        held.etag += 1;
        return json(supplierAnswer(id, held).fields);
      }
    ),
  ];
};

export const appControls = {
  /** The person shares their own notebook `id` with someone. */
  shareNotebook: (id: string): void => {
    sharedSince.add(id);
  },
  /** Someone changes a supplier's columns in SharePoint, as they could. */
  editSupplier: (id: string, fields: Record<string, unknown>): void => {
    const held = supplierItems.get(id);
    if (held !== undefined) {
      held.fields = { ...held.fields, ...fields };
      held.etag += 1;
    }
  },
  /** A supplier's columns, as SharePoint holds them. */
  supplierOf: (id: string): Record<string, unknown> | undefined =>
    supplierItems.get(id)?.fields,
  /** A plan's tasks, as Planner holds them. */
  plannerTasksOf: (plan: string): readonly Record<string, unknown>[] =>
    tasksOfPlan(plan),
  /** The person's OneNote pages' HTML, by title, as OneNote holds them. */
  notePageHtml: (owner: string, title: string): string | undefined =>
    pagesOf(owner).find((page) => page.title === title)?.html,
};
