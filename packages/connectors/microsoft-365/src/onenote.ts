import { defineTool, ToolError } from "@grasp-os/connector-kit/connector";
import { segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  atPage,
  graphFetch,
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
import { decoded } from "./text.ts";

// OneNote, of one person per call, as `/users/{mailbox}` like To Do, so a
// call's capability binds every request to them. These reach only the
// person's own: Graph lets a delegated token (`Notes.Read`,
// `Notes.ReadWrite`) into the signed-in user's notebooks, and a notebook
// they share with others, or someone shares with them, is refused here,
// so a page is never read or made where another person sees it.

const users = `${v1}/users/{mailbox}`;

const get = (path: string) =>
  ({ method: "GET", host: graphHost, path: `${users}${path}` }) as const;

const graphNotebook = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  isShared: z.boolean().nullish(),
  userRole: z.string().nullish(),
});
type GraphNotebook = z.infer<typeof graphNotebook>;

const graphSection = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
  parentNotebook: graphNotebook.nullish(),
});
type GraphSection = z.infer<typeof graphSection>;

const graphPage = z.object({
  id: z.string(),
  title: z.string().nullish(),
  createdDateTime: z.string().nullish(),
  lastModifiedDateTime: z.string().nullish(),
  parentNotebook: graphNotebook.nullish(),
  parentSection: z.object({ id: z.string() }).nullish(),
});
type GraphPage = z.infer<typeof graphPage>;

const notebookFields = "id,displayName,isShared,userRole";
const withNotebook = `parentNotebook($select=${notebookFields})`;
const pageFields = "id,title,createdDateTime,lastModifiedDateTime";

/** Whether a notebook is the person's alone: theirs, and shared with no one. */
const isOwn = (notebook: GraphNotebook | null | undefined): boolean =>
  notebook?.userRole === "Owner" && notebook.isShared === false;

const sectionSchema = z.strictObject({
  id: z.string(),
  name: z.string().nullable(),
  notebookId: z.string(),
  notebook: z.string().nullable(),
});

const sectionOf = (
  section: GraphSection & { parentNotebook: GraphNotebook }
): z.infer<typeof sectionSchema> => ({
  id: section.id,
  name: section.displayName ?? null,
  notebookId: section.parentNotebook.id,
  notebook: section.parentNotebook.displayName ?? null,
});

const notePageSchema = z.strictObject({
  id: z.string(),
  title: z.string().nullable(),
  createdAt: z.string().nullable(),
  lastModifiedAt: z.string().nullable(),
});

const pageOutputOf = (page: GraphPage): z.infer<typeof notePageSchema> => ({
  id: page.id,
  title: page.title ?? null,
  createdAt: page.createdDateTime ?? null,
  lastModifiedAt: page.lastModifiedDateTime ?? null,
});

const notOwn = (): ToolError =>
  new ToolError("This notebook is shared, so it isn't only the person's own", {
    code: "access_denied",
  });

const sectionPath = (mailbox: string, section: string): string =>
  `/users/${segment(mailbox)}/onenote/sections/${segment(section)}`;

/**
 * The person's section `section`, once Graph says its notebook is theirs
 * alone; a ToolError otherwise. Every tool on a section asks this first, a
 * read before its one write.
 */
const ownSection = async (
  mailbox: string,
  section: string
): Promise<GraphSection & { parentNotebook: GraphNotebook }> => {
  const found = await graphJson(
    graphUrl(sectionPath(mailbox, section), { $expand: withNotebook }),
    graphSection
  );
  const notebook = found.parentNotebook;
  if (notebook === null || notebook === undefined || !isOwn(notebook)) {
    throw notOwn();
  }
  return { ...found, parentNotebook: notebook };
};

const listSections = defineTool({
  name: "onenote.sections",
  description:
    "Lists the sections of a person's own OneNote notebooks, the ones shared with no one; notebooks shared with or by them are left out.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    top: topSchema,
    page: pageSchema,
  }),
  output: z.strictObject({
    mailbox: z.string(),
    sections: z.array(sectionSchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  reach: "own",
  resource: "mailbox",
  routes: [get("/onenote/sections")],
  run: async ({ mailbox, top, page }) => {
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      atPage(
        graphUrl(`/users/${segment(mailbox)}/onenote/sections`, {
          $select: "id,displayName",
          $expand: withNotebook,
          $top: String(top ?? 25),
        }),
        page
      ),
      pageOf(graphSection)
    );
    const own = value.flatMap((section) =>
      section.parentNotebook !== null &&
      section.parentNotebook !== undefined &&
      isOwn(section.parentNotebook)
        ? [{ ...section, parentNotebook: section.parentNotebook }]
        : []
    );
    return {
      output: {
        mailbox,
        sections: own.map(sectionOf),
        nextPage: nextPageOf(nextLink),
      },
      provenance: own.map(({ id }) => id),
    };
  },
});

const listPages = defineTool({
  name: "onenote.pages",
  description:
    "Lists the pages of a section of one of a person's own OneNote notebooks, newest change first.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    section: idSchema,
    top: topSchema,
    page: pageSchema,
  }),
  output: z.strictObject({
    mailbox: z.string(),
    sectionId: z.string(),
    pages: z.array(notePageSchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  reach: "own",
  resource: "mailbox",
  routes: [
    get("/onenote/sections/{section}"),
    get("/onenote/sections/{section}/pages"),
  ],
  run: async ({ mailbox, section, top, page }) => {
    await ownSection(mailbox, section);
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      atPage(
        graphUrl(`${sectionPath(mailbox, section)}/pages`, {
          $select: pageFields,
          $orderby: "lastModifiedDateTime desc",
          $top: String(top ?? 25),
        }),
        page
      ),
      pageOf(graphPage)
    );
    return {
      output: {
        mailbox,
        sectionId: section,
        pages: value.map(pageOutputOf),
        nextPage: nextPageOf(nextLink),
      },
      provenance: value.map(({ id }) => id),
    };
  },
});

/** The most of a page's HTML read, in bytes. */
const maxPageBytes = 2 * 1024 * 1024;

const blockEnd =
  /<\/(?:p|div|h[1-6]|li|tr|table|ul|ol|pre|blockquote)\s*>|<br\s*\/?>/giu;
const cellEnd = /<\/t[dh]\s*>/giu;
const hidden = /<(?<element>script|style|head)\b[\s\S]*?<\/\k<element>\s*>/giu;
const tag = /<[^>]*>/gu;
const htmlEntities: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const blankLines = /\n{2,}/gu;
const trailingSpace = /[ \t]+\n/gu;

/**
 * A OneNote page's text, from the HTML Graph gives it in: a line per
 * paragraph, heading, list item and table row, cells apart by a tab, and
 * no blank lines. Images, ink and attachments aren't text, and are left
 * out.
 */
const pageText = (html: string): string =>
  decoded(
    html
      .replaceAll(hidden, "")
      .replaceAll(cellEnd, "\t")
      .replaceAll(blockEnd, "\n")
      .replaceAll(tag, ""),
    htmlEntities
  )
    .replaceAll(trailingSpace, "\n")
    .replaceAll(blankLines, "\n")
    .trim();

const readPage = defineTool({
  name: "onenote.read",
  description:
    "Reads the text of a page of one of a person's own OneNote notebooks: a line per paragraph, list item and table row.",
  input: z.strictObject({ mailbox: mailboxSchema, page: idSchema }),
  output: z.strictObject({
    mailbox: z.string(),
    page: notePageSchema,
    sectionId: z.string().nullable(),
    text: z.string(),
  }),
  readOnly: true,
  reach: "own",
  resource: "mailbox",
  routes: [get("/onenote/pages/{page}"), get("/onenote/pages/{page}/content")],
  run: async ({ mailbox, page: id }) => {
    const path = `/users/${segment(mailbox)}/onenote/pages/${segment(id)}`;
    const found = await graphJson(
      graphUrl(path, {
        $select: pageFields,
        $expand: `${withNotebook},parentSection($select=id)`,
      }),
      graphPage
    );
    if (!isOwn(found.parentNotebook)) {
      throw notOwn();
    }
    const response = await graphFetch(graphUrl(`${path}/content`));
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxPageBytes) {
      throw new ToolError("This page is too large to read", {
        code: "too_large",
      });
    }
    return {
      output: {
        mailbox,
        page: pageOutputOf(found),
        sectionId: found.parentSection?.id ?? null,
        text: pageText(new TextDecoder().decode(bytes)),
      },
      provenance: [found.id],
    };
  },
});

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

const createPage = defineTool({
  name: "onenote.create",
  description:
    "Adds a page, such as notes from a meeting, to a section of one of a person's own OneNote notebooks: its title, and its text a paragraph per line.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    section: idSchema,
    title: z.string().min(1).max(255),
    text: z.string().max(256 * 1024),
  }),
  output: z.strictObject({
    mailbox: z.string(),
    sectionId: z.string(),
    page: notePageSchema,
  }),
  readOnly: false,
  reach: "own",
  destructive: false,
  resource: "mailbox",
  // Recovery `none`: OneNote keeps no property of ours on a page that a
  // lookup could filter on, and the same notes may rightly be added twice,
  // so a page of unknown outcome stays unknown, for its person to say what
  // became of it.
  routes: [
    get("/onenote/sections/{section}"),
    {
      method: "POST",
      host: graphHost,
      path: `${users}/onenote/sections/{section}/pages`,
    },
  ],
  describe: {
    title: "Add a page to OneNote",
    fields: [
      { label: "For", input: "mailbox" },
      { label: "Section", input: "section" },
      { label: "Title", input: "title" },
      { label: "Text", input: "text" },
    ],
  },
  run: async ({ mailbox, section, title, text }) => {
    await ownSection(mailbox, section);
    const made = await graphJson(
      graphUrl(`${sectionPath(mailbox, section)}/pages`),
      graphPage,
      {
        method: "POST",
        headers: { "content-type": "text/html" },
        body: pageHtml(title, text),
      }
    );
    const page = pageOutputOf(made);
    return {
      output: { mailbox, sectionId: section, page },
      change: { before: null, after: { ...page, text } },
    };
  },
});

export const onenoteTools = [listSections, listPages, readPage, createPage];
