import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { connectAccount, outcome, ownAccount, someone } from "./connect.ts";
import {
  contractText,
  meetingPage,
  meetingText,
  notebooks,
  planIds,
  sectionIds,
  suppliersList,
} from "./fixtures/graph-apps.ts";
import {
  ceo,
  financeDrive,
  financeSite,
  hrSite,
  itemIds,
} from "./fixtures/graph.ts";
import { fakeGraph } from "./graph-api.ts";
import { fakeProviders } from "./oauth-provider.ts";
import {
  callTool as call,
  claimedAgo,
  outputOf,
  parsedRequests,
  toolError,
} from "./tool-calls.ts";
import type { Connection, Input } from "./tool-calls.ts";

// More of Microsoft 365 by class (GRA-749): Word documents' text, Planner,
// OneNote and writing SharePoint lists, each tool through its class
// (connectors.test.ts holds each tool's class, class-rights.test.ts each
// class's rights).
// Against Graph's recorded answers, through connect's real call path. The
// ways each can fail, which the tests start from: a tool that reaches
// further than its class says (a page in a notebook someone else sees, a
// task that tells someone it is theirs); a write that overwrites what
// someone changed since it was read; a write of unknown outcome made
// twice; a read that hands back markup or a zip instead of the words.

const providers = fakeProviders();
const graph = fakeGraph(providers);

const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(providers, person, ownAccount(person));
  return { id, person };
};

const ownMailbox = ({ person }: Connection): string => person.email;

/** What left connect, each request with its query and JSON body parsed. */
const requests = () => parsedRequests(graph.sent);

describe("the Microsoft 365 connector's Word tool", () => {
  it("reads a Word document's words: a line per paragraph, its tabs and line breaks kept", async () => {
    const connection = await connected();
    await expect(
      outputOf(
        call(
          connection,
          "word.read",
          { drive: financeDrive, item: itemIds.contract },
          { resource: financeDrive }
        )
      )
    ).resolves.toMatchObject({
      drive: financeDrive,
      id: itemIds.contract,
      name: "Supply agreement Northwind.docx",
      text: contractText,
    });
  });

  it("refuses a file that isn't a Word document, and one the person may not open", async () => {
    const connection = await connected();
    const read = async (item: string) =>
      await toolError(
        call(
          connection,
          "word.read",
          { drive: financeDrive, item },
          { resource: financeDrive }
        )
      );
    await expect(read(itemIds.report)).resolves.toMatchObject({
      error: { code: "not_text" },
    });
    await expect(read(itemIds.locked)).resolves.toMatchObject({
      error: { code: "access_denied" },
    });
    // A file too big to read is refused before its content is asked for.
    await expect(read(itemIds.big)).resolves.toMatchObject({
      error: { code: "too_large" },
    });
    expect(
      requests().filter(({ path }) => path.endsWith("/content"))
    ).toHaveLength(1);
  });
});

const plannerCall = async (
  connection: Connection,
  action: string,
  input: Input,
  idempotencyKey?: string
) =>
  await outputOf(
    call(
      connection,
      action,
      { plan: planIds.finance, ...input },
      {
        resource: planIds.finance,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }
    )
  );

describe("the Microsoft 365 connector's Planner tools", () => {
  it("read a plan's tasks a page at a time, and only the open ones when asked", async () => {
    const connection = await connected();
    const first = await plannerCall(connection, "planner.tasks", {});
    expect(first).toMatchObject({
      plan: planIds.finance,
      tasks: [
        {
          title: "Reconcile supplier statement 1",
          assignedTo: ["fbab97d0-4932-4511-b675-204639209557"],
        },
        { title: "Reconcile supplier statement 2", percentComplete: 100 },
      ],
      nextPage: "%24skiptoken=2",
    });
    const { nextPage } = z.object({ nextPage: z.string() }).parse(first);
    await expect(
      plannerCall(connection, "planner.tasks", { page: nextPage })
    ).resolves.toMatchObject({
      tasks: [{ title: "Reconcile supplier statement 3" }],
      nextPage: null,
    });
    await expect(
      plannerCall(connection, "planner.tasks", { openOnly: true })
    ).resolves.toMatchObject({
      tasks: [{ title: "Reconcile supplier statement 1" }],
    });
  });

  it("add a task to the bound plan, assigned to no one, with its due day", async () => {
    const connection = await connected();
    const made = await plannerCall(
      connection,
      "planner.create",
      { title: "Reconcile Fabrikam's statement", due: "2026-10-30" },
      "run-1:planner"
    );
    expect(made).toMatchObject({
      plan: planIds.finance,
      task: {
        title: "Reconcile Fabrikam's statement",
        due: "2026-10-30T12:00:00Z",
        assignedTo: [],
      },
    });
    const sent = requests().find(({ method }) => method === "POST");
    expect(sent).toMatchObject({
      path: "/v1.0/planner/tasks",
      body: {
        planId: planIds.finance,
        title: "Reconcile Fabrikam's statement",
        dueDateTime: "2026-10-30T12:00:00Z",
      },
    });
    expect(sent?.body).not.toHaveProperty("assignments");
    expect(graph.plannerTasksOf(planIds.finance)).toHaveLength(4);
  });

  it("refuse a plan of a group the person isn't in before anything is made", async () => {
    const connection = await connected();
    await expect(
      toolError(
        call(
          connection,
          "planner.create",
          { plan: planIds.hr, title: "Anything" },
          { resource: planIds.hr, idempotencyKey: "run-2:planner" }
        )
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
    expect(graph.writesDone()).toBe(0);
  });

  it("never add a task twice when its answer was lost: its outcome stays unknown", async () => {
    const connection = await connected();
    const task = {
      plan: planIds.finance,
      title: "Reconcile Fabrikam's statement",
    };
    const options = {
      resource: planIds.finance,
      idempotencyKey: "run-3:planner",
    };
    graph.loseWriteAnswer();
    await expect(
      outcome(call(connection, "planner.create", task, options))
    ).resolves.toBe("connect.outcome_unknown");
    await claimedAgo(connection);
    await expect(
      outcome(call(connection, "planner.create", task, options))
    ).resolves.toBe("connect.outcome_unknown");
    expect(graph.writesDone()).toBe(1);
  });
});

const onenote = async (
  connection: Connection,
  action: string,
  input: Input,
  idempotencyKey?: string
) =>
  await outputOf(
    call(
      connection,
      action,
      { mailbox: ownMailbox(connection), ...input },
      {
        resource: ownMailbox(connection),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }
    )
  );

describe("the Microsoft 365 connector's OneNote tools", () => {
  const notes = {
    section: sectionIds.own,
    title: "Fabrikam call",
    text: "Agreed: <b>net 30</b> & a 2% discount\n\nCall back Monday",
  };

  it("list only the sections of the person's own notebooks", async () => {
    const connection = await connected();
    await expect(
      onenote(connection, "onenote.sections", {})
    ).resolves.toStrictEqual({
      mailbox: ownMailbox(connection),
      sections: [
        {
          id: sectionIds.own,
          name: "Meetings",
          notebookId: notebooks.own.id,
          notebook: "Work notes",
        },
      ],
      nextPage: null,
    });
  });

  it("read a page's words, not its markup", async () => {
    const connection = await connected();
    await expect(
      onenote(connection, "onenote.pages", { section: sectionIds.own })
    ).resolves.toMatchObject({
      pages: [{ id: meetingPage.id, title: "Northwind call" }],
    });
    await expect(
      onenote(connection, "onenote.read", { page: meetingPage.id })
    ).resolves.toMatchObject({
      page: { id: meetingPage.id, title: "Northwind call" },
      sectionId: sectionIds.own,
      text: meetingText,
    });
  });

  it("add a page of notes to the person's own section, its text kept as text", async () => {
    const connection = await connected();
    const made = await onenote(
      connection,
      "onenote.create",
      notes,
      "run-1:notes"
    );
    expect(made).toMatchObject({
      sectionId: sectionIds.own,
      page: { title: "Fabrikam call" },
    });
    const { page } = z
      .object({ page: z.object({ id: z.string() }) })
      .parse(made);
    // What the person typed reads back as they typed it: none of it became
    // markup on the page.
    await expect(
      onenote(connection, "onenote.read", { page: page.id })
    ).resolves.toMatchObject({
      text: "Agreed: <b>net 30</b> & a 2% discount\nCall back Monday",
    });
  });

  it("refuse another person's OneNote, and notebooks shared with or by the person", async () => {
    const connection = await connected();
    await expect(
      toolError(
        call(
          connection,
          "onenote.create",
          { ...notes, mailbox: ceo },
          { resource: ceo, idempotencyKey: "run-2:theirs" }
        )
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
    const calls: [string, Input][] = [
      sectionIds.sharedByThem,
      sectionIds.sharedWithThem,
    ].flatMap((section): [string, Input][] => [
      ["onenote.pages", { section }],
      ["onenote.create", { ...notes, section }],
    ]);
    const refusals = await Promise.all(
      calls.map(
        async ([action, input]) =>
          await toolError(
            call(
              connection,
              action,
              { mailbox: ownMailbox(connection), ...input },
              {
                resource: ownMailbox(connection),
                idempotencyKey: crypto.randomUUID(),
              }
            )
          )
      )
    );
    expect(refusals).toMatchObject(
      calls.map(() => ({ error: { code: "access_denied" } }))
    );
    expect(graph.writesDone()).toBe(0);
  });

  it("read no page of a notebook the person has since shared", async () => {
    const connection = await connected();
    graph.shareNotebook(notebooks.own.id);
    await expect(
      toolError(
        call(
          connection,
          "onenote.read",
          { mailbox: ownMailbox(connection), page: meetingPage.id },
          { resource: ownMailbox(connection) }
        )
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
    expect(
      requests().filter(({ path }) => path.endsWith("/content"))
    ).toStrictEqual([]);
    await expect(
      onenote(connection, "onenote.sections", {})
    ).resolves.toMatchObject({ sections: [] });
  });
});

const listCall = async (
  connection: Connection,
  action: string,
  input: Input,
  idempotencyKey: string
) =>
  await outputOf(
    call(
      connection,
      action,
      { site: financeSite, list: suppliersList, ...input },
      { resource: financeSite, idempotencyKey }
    )
  );

describe("the Microsoft 365 connector's list writes", () => {
  const raise = {
    item: "1",
    before: [{ column: "CreditLimit", value: 5000 }],
    after: [
      { column: "CreditLimit", value: 7500 },
      { column: "Notes", value: "Raised after the Q3 review" },
    ],
  };

  it("add an item with its columns", async () => {
    const connection = await connected();
    await expect(
      listCall(
        connection,
        "lists.addItem",
        {
          values: [
            { column: "Title", value: "Fabrikam Metals" },
            { column: "Approved", value: false },
            { column: "CreditLimit", value: 2500 },
          ],
        },
        "run-1:supplier"
      )
    ).resolves.toMatchObject({
      site: financeSite,
      list: suppliersList,
      item: {
        id: "2",
        fields: {
          Title: "Fabrikam Metals",
          Approved: false,
          CreditLimit: 2500,
        },
      },
    });
    expect(graph.supplierOf("2")).toStrictEqual({
      Title: "Fabrikam Metals",
      Approved: false,
      CreditLimit: 2500,
    });
  });

  it("change an item from what was read, and find it already changed on a repeat", async () => {
    const connection = await connected();
    const changed = await listCall(
      connection,
      "lists.updateItem",
      raise,
      "run-2:raise"
    );
    expect(changed).toMatchObject({
      item: {
        id: "1",
        fields: {
          Title: "Northwind Supplies",
          CreditLimit: 7500,
          Notes: "Raised after the Q3 review",
        },
      },
    });
    // SharePoint's own columns stay out of what the tool hands back.
    expect(changed).not.toHaveProperty("item.fields.ContentType");
    // The same change again finds the item standing as asked, and writes
    // nothing.
    await listCall(connection, "lists.updateItem", raise, "run-3:raise");
    expect(graph.writesDone()).toBe(1);
    const patch = requests().find(({ method }) => method === "PATCH");
    expect(patch).toMatchObject({
      path: `/v1.0/sites/${encodeURIComponent(financeSite)}/lists/${suppliersList}/items/1/fields`,
      body: { CreditLimit: 7500, Notes: "Raised after the Q3 review" },
    });
  });

  it("refuse a change to an item someone changed since it was read", async () => {
    const connection = await connected();
    graph.editSupplier("1", { CreditLimit: 6000 });
    await expect(
      toolError(
        call(
          connection,
          "lists.updateItem",
          { site: financeSite, list: suppliersList, ...raise },
          { resource: financeSite, idempotencyKey: "run-4:raise" }
        )
      )
    ).resolves.toMatchObject({ error: { code: "conflict" } });
    expect(graph.writesDone()).toBe(0);
    expect(graph.supplierOf("1")).toMatchObject({ CreditLimit: 6000 });
  });

  it("refuse writing SharePoint's own columns, and a column named twice, before anything goes out", async () => {
    const connection = await connected();
    const sent = graph.sent.length;
    await expect(
      toolError(
        call(
          connection,
          "lists.addItem",
          {
            site: financeSite,
            list: suppliersList,
            values: [
              { column: "Title", value: "Fabrikam Metals" },
              { column: "ContentType", value: "Document" },
            ],
          },
          { resource: financeSite, idempotencyKey: "run-5:supplier" }
        )
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    await expect(
      toolError(
        call(
          connection,
          "lists.addItem",
          {
            site: financeSite,
            list: suppliersList,
            values: [
              { column: "Title", value: "Fabrikam Metals" },
              { column: "Title", value: "Contoso Paper" },
            ],
          },
          { resource: financeSite, idempotencyKey: "run-6:supplier" }
        )
      )
    ).resolves.toBe("Invalid input: custom at values");
    expect(graph.sent).toHaveLength(sent);
  });

  it("write to no site but the one the person may change", async () => {
    const connection = await connected();
    await expect(
      toolError(
        call(
          connection,
          "lists.addItem",
          {
            site: hrSite,
            list: suppliersList,
            values: [{ column: "Title", value: "Fabrikam Metals" }],
          },
          { resource: hrSite, idempotencyKey: "run-7:supplier" }
        )
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
  });
});
