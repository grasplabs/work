import { page, tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { Api, Infer } from "@grasp-os/sdk/connector";

import {
  checkIds,
  graphId,
  graphPage,
  next,
  nextOf,
  positionOf,
  top,
} from "./graph-sdk.ts";
import { htmlText } from "./text.ts";

// OneNote, the signed-in person's own: every route is under `/me`, so a
// call reaches no one else's notebooks. A notebook they share with others,
// or someone shares with them, is refused here, so a page is never read
// or made where another person sees it.

const sectionsRoute = "/me/onenote/sections";
const sectionRoute = "/me/onenote/sections/{section}";
const sectionPagesRoute = "/me/onenote/sections/{section}/pages";
const pageRoute = "/me/onenote/pages/{page}";
const contentRoute = "/me/onenote/pages/{page}/content";

/** A notebook (Graph's notebook), with whose it is. */
const Notebook = v.object({
  id: v.string(),
  displayName: v.string().nullable().optional(),
  isShared: v.boolean().nullable().optional(),
  userRole: v.string().nullable().optional(),
});

/** Whether a notebook is the person's alone: theirs, and shared with no one. */
const isOwn = (
  notebook: Infer<typeof Notebook> | null | undefined
): notebook is Infer<typeof Notebook> =>
  notebook?.userRole === "Owner" && notebook.isShared === false;

const notebookFields = "id,displayName,isShared,userRole";
const withNotebook = `parentNotebook($select=${notebookFields})`;

/** A section with its notebook, as Graph answers it expanded. */
const GraphSection = v.object({
  id: v.string(),
  displayName: v.string().nullable().optional(),
  parentNotebook: Notebook.nullable().optional(),
});

/** A section (Graph's onenoteSection), narrowed to its name and notebook's. */
const Section = v.object({
  id: v.string(),
  displayName: v.string().nullable().optional(),
  parentNotebook: v.object({
    id: v.string(),
    displayName: v.string().nullable().optional(),
  }),
});

const pageFields = {
  id: v.string(),
  title: v.string().nullable().optional(),
  createdDateTime: v.string().nullable().optional(),
  lastModifiedDateTime: v.string().nullable().optional(),
};

/** A page (Graph's onenotePage), narrowed to these fields. */
const NotePage = v.object(pageFields);

const selectPage = Object.keys(pageFields).join(",");

const notOwn = (): ToolError =>
  new ToolError("This notebook is shared, so it isn't only the person's own", {
    code: "access_denied",
  });

/**
 * Refuses the section unless Graph says its notebook is the person's
 * alone. Every tool on a section asks this first, a read before its one
 * write.
 */
const ownSection = async (api: Api, section: string): Promise<void> => {
  const found = await api.get(sectionRoute, {
    path: { section },
    query: { $select: "id", $expand: withNotebook },
    returns: GraphSection,
  });
  if (!isOwn(found.parentNotebook)) {
    throw notOwn();
  }
};

/** The most of a page's HTML read, in bytes. */
const maxPageBytes = 2 * 1024 * 1024;

/** Text as HTML takes it: no markup of its own. */
const escaped = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const lineBreak = /\r\n|\r|\n/u;

/** A page's HTML as OneNote takes it: its title, and a paragraph per line. */
const pageHtml = (title: string, text: string): string =>
  `<!DOCTYPE html><html><head><title>${escaped(title)}</title></head><body>${text
    .split(lineBreak)
    .map((line) => `<p>${escaped(line)}</p>`)
    .join("")}</body></html>`;

/**
 * The person's own OneNote tools, by name: each named from its route
 * (`POST /me/onenote/sections/{section}/pages` is
 * `me.onenote.sections.pages.create`).
 */
export const onenoteTools = {
  "me.onenote.sections.list": tool({
    description:
      "Lists the sections of the person's own OneNote notebooks, a page at a time, each with its notebook. Notebooks shared with them or by them are left out.",
    readOnly: true,
    reach: "own",
    scopes: ["Notes.Read"],
    routes: [`GET ${sectionsRoute}`],
    args: { top, next },
    returns: page(Section),
    handler: async (args, api) => {
      const answer = await api.get(sectionsRoute, {
        query: {
          $select: "id,displayName",
          $expand: withNotebook,
          $top: args.top ?? 25,
          ...positionOf(args.next),
        },
        returns: graphPage(GraphSection),
      });
      return {
        items: answer.value.flatMap(({ id, displayName, parentNotebook }) =>
          isOwn(parentNotebook)
            ? [
                {
                  id,
                  displayName,
                  parentNotebook: {
                    id: parentNotebook.id,
                    displayName: parentNotebook.displayName,
                  },
                },
              ]
            : []
        ),
        next: nextOf(answer["@odata.nextLink"]),
      };
    },
  }),
  "me.onenote.sections.pages.list": tool({
    description:
      "Lists the pages of a section of one of the person's own OneNote notebooks, a page at a time, newest change first. A section of a notebook shared with them or by them is refused.",
    readOnly: true,
    reach: "own",
    scopes: ["Notes.Read"],
    routes: [`GET ${sectionPagesRoute}`, `GET ${sectionRoute}`],
    args: { section: graphId, top, next },
    returns: page(NotePage),
    handler: async ({ section, ...args }, api) => {
      checkIds({ section });
      await ownSection(api, section);
      const answer = await api.get(sectionPagesRoute, {
        path: { section },
        query: {
          $select: selectPage,
          $orderby: "lastModifiedDateTime desc",
          $top: args.top ?? 25,
          ...positionOf(args.next),
        },
        returns: graphPage(NotePage),
      });
      return { items: answer.value, next: nextOf(answer["@odata.nextLink"]) };
    },
  }),
  "me.onenote.pages.get": tool({
    description:
      "Reads a page of one of the person's own OneNote notebooks, with its section, and its content as text: a line per paragraph, list item and table row. A page of a notebook shared with them or by them is refused.",
    readOnly: true,
    // One item's content: what the Brain keeps of a person's own (GRA-1730).
    answersItem: true,
    reach: "own",
    scopes: ["Notes.Read"],
    routes: [`GET ${pageRoute}`, `GET ${contentRoute}`],
    args: { page: graphId },
    returns: v.object({
      ...pageFields,
      parentSection: v.object({ id: v.string() }).nullable().optional(),
      content: v.string(),
    }),
    handler: async ({ page: id }, api) => {
      checkIds({ page: id });
      const { parentNotebook, ...found } = await api.get(pageRoute, {
        path: { page: id },
        query: {
          $select: selectPage,
          $expand: `${withNotebook},parentSection($select=id)`,
        },
        returns: v.object({
          ...pageFields,
          parentNotebook: Notebook.nullable().optional(),
          parentSection: v.object({ id: v.string() }).nullable().optional(),
        }),
      });
      if (!isOwn(parentNotebook)) {
        throw notOwn();
      }
      const html = await api.get(contentRoute, { path: { page: id } });
      if (typeof html !== "string") {
        throw new ToolError("This page's content isn't HTML", {
          code: "failed",
        });
      }
      if (new TextEncoder().encode(html).byteLength > maxPageBytes) {
        throw new ToolError("This page is too large to read", {
          code: "too_large",
        });
      }
      return { ...found, content: htmlText(html) };
    },
  }),
  "me.onenote.sections.pages.create": tool({
    description:
      "Adds a page, such as notes from a meeting, to a section of one of the person's own OneNote notebooks: its title, and its content as text, a paragraph per line. A section of a notebook shared with them or by them is refused.",
    readOnly: false,
    reach: "own",
    scopes: ["Notes.ReadWrite"],
    // No recovery: OneNote keeps no property of ours on a page that a
    // lookup could filter on, and the same notes may rightly be added
    // twice, so a page of unknown outcome stays unknown, for its person to
    // say what became of it.
    routes: [`POST ${sectionPagesRoute}`, `GET ${sectionRoute}`],
    args: {
      section: graphId,
      title: v.string().min(1).max(255),
      content: v.string().max(256 * 1024),
    },
    returns: NotePage,
    describe: {
      title: "Add a page to OneNote",
      fields: [
        { label: "Section", arg: "section" },
        { label: "Title", arg: "title" },
        { label: "Text", arg: "content" },
      ],
    },
    handler: async ({ section, title, content }, api, call) => {
      checkIds({ section });
      await ownSection(api, section);
      const made = await api.post(sectionPagesRoute, {
        path: { section },
        contentType: "text/html",
        body: pageHtml(title, content),
        returns: NotePage,
      });
      call.changed({ before: null, after: { ...made, content } });
      return made;
    },
  }),
};
