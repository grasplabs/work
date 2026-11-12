import { signCapability } from "@grasp-os/shared/capability";
import type { PendingAction } from "@grasp-os/shared/connect";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callChanges } from "../src/db/schema.ts";
import {
  agentFor,
  callAs,
  chatOrigin,
  connectAccount,
  outcome,
  ownAccount,
} from "./connect.ts";
import {
  childrenSkipToken,
  contractCount,
  contractsList,
  financeDrive,
  financeSite,
  hrSite,
  itemIds,
  pdfBase64,
  procedureTexts,
  reportText,
  supplierColumns,
  supplierTable,
  totalsRange,
  workbookIds,
} from "./fixtures/graph.ts";
import {
  audit,
  connected,
  contoso,
  drivePath,
  expire,
  fabrikam,
  graph,
  graphPaths,
  northwind,
  providers,
  requests,
  statusOf,
  supplierTableOf,
  versionSize,
  withAmount,
  withIban,
} from "./microsoft-365-harness.ts";
import type { SupplierRow } from "./microsoft-365-harness.ts";
import {
  callTool as call,
  claimedAgo,
  outputOf,
  resultOf,
  toolError,
} from "./tool-calls.ts";
import type { Connection, Input } from "./tool-calls.ts";

// The Microsoft 365 connector against Graph's recorded answers, through
// connect's real call path: capability, policy, a fresh isolate, the
// egress (which adds the token and holds each call to its routes), and
// back. Scoping comes first: a call for one mailbox or drive reaches only
// that one, by construction.

describe("the Microsoft 365 connector's file tools", () => {
  it("list a drive's top folder or a folder in it, page by page", async () => {
    const connection = await connected();
    const first = await resultOf(
      call(connection, "files.list", { drive: financeDrive })
    );
    expect(first).toMatchObject({
      output: {
        drive: financeDrive,
        items: [
          { drive: financeDrive, id: itemIds.folder, kind: "folder" },
          {
            drive: financeDrive,
            id: itemIds.report,
            kind: "file",
            mimeType: "text/plain",
          },
        ],
        nextPage: `%24skiptoken=${childrenSkipToken}`,
      },
      provenance: [itemIds.folder, itemIds.report],
    });
    await call(connection, "files.list", {
      drive: financeDrive,
      folder: itemIds.folder,
      page: `%24skiptoken=${childrenSkipToken}`,
    });
    expect(requests()).toMatchObject([
      { path: `${drivePath}/root/children` },
      {
        path: `${drivePath}/items/${itemIds.folder}/children`,
        query: { $skiptoken: childrenSkipToken },
      },
    ]);
  });

  it("search a drive, quoting the query as OData does, and pass on its own items only", async () => {
    const connection = await connected();
    // Graph finds an item shared from another drive too: it's left out.
    await expect(
      resultOf(
        call(connection, "files.search", {
          drive: financeDrive,
          query: "Northwind's invoice",
        })
      )
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        items: [expect.objectContaining({ id: itemIds.pdf })],
        nextPage: null,
      },
      provenance: [itemIds.pdf],
    });
    expect(graph.sent[0]?.path).toMatch(
      new RegExp(
        String.raw`^${drivePath}/root/search\(q='Northwind''s%20invoice'\)\?`,
        "u"
      )
    );
    // A query the egress would refuse in a path is refused before it.
    await expect(
      toolError(
        call(connection, "files.search", {
          drive: financeDrive,
          query: "../../me",
        })
      )
    ).resolves.toBe("Invalid input: invalid_format at query");
    expect(graph.sent).toHaveLength(1);
  });

  it("read a file through SharePoint's download, without the token going there", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(connection, "files.read", {
          drive: financeDrive,
          item: itemIds.report,
        })
      )
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        id: itemIds.report,
        name: "Month-end report.txt",
        version: null,
        mimeType: "text/plain",
        size: new TextEncoder().encode(reportText).byteLength,
        encoding: "text",
        content: reportText,
      },
      provenance: [itemIds.report],
    });
    expect(requests()).toMatchObject([
      {
        host: "graph.microsoft.com",
        path: `${drivePath}/items/${itemIds.report}`,
      },
      {
        host: "graph.microsoft.com",
        path: `${drivePath}/items/${itemIds.report}/content`,
      },
      {
        host: graph.sharePointHost,
        path: "/sites/Finance/_layouts/15/download.aspx",
        query: { UniqueId: itemIds.report },
      },
    ]);
    expect(graph.sent[2]?.headers).not.toHaveProperty("authorization");
    const pdf = { drive: financeDrive, item: itemIds.pdf };
    await expect(
      outputOf(call(connection, "files.read", { ...pdf, as: "base64" }))
    ).resolves.toMatchObject({ encoding: "base64", content: pdfBase64 });
    await expect(
      toolError(call(connection, "files.read", { ...pdf, as: "text" }))
    ).resolves.toMatchObject({ error: { code: "not_text" } });
  });

  it("read no folder, no other drive's file, and no file past the size limit", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      [itemIds.folder, itemIds.foreign, itemIds.big, itemIds.controls].map(
        async (item) =>
          await toolError(
            call(connection, "files.read", { drive: financeDrive, item })
          )
      )
    );
    // A text file whose escaped content would pass the answer's limit is
    // refused once read; the others before their content is asked for.
    expect(refusals).toMatchObject([
      { error: { code: "not_a_file" } },
      { error: { code: "not_found" } },
      { error: { code: "too_large" } },
      { error: { code: "too_large" } },
    ]);
    expect(
      graphPaths().filter((path) => path.endsWith("/content"))
    ).toStrictEqual([`${drivePath}/items/${itemIds.controls}/content`]);
  });

  it("list a file's versions newest first, each with when and by whom it was saved", async () => {
    const connection = await connected();
    const sanne = { name: "Sanne Visser", email: "sanne.visser@example.com" };
    // Graph's pre-authenticated download link of each isn't passed on.
    await expect(
      resultOf(
        call(connection, "files.versions", {
          drive: financeDrive,
          item: itemIds.procedure,
        })
      )
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        id: itemIds.procedure,
        name: "Advice procedure.txt",
        versions: [
          {
            id: "3.0",
            current: true,
            savedAt: "2026-10-12T09:41:07Z",
            savedBy: sanne,
            size: versionSize("3.0"),
          },
          {
            id: "2.0",
            current: false,
            savedAt: "2026-06-03T14:20:55Z",
            savedBy: {
              name: "Daan Bakker",
              email: "daan.bakker@example.com",
            },
            size: versionSize("2.0"),
          },
          {
            id: "1.0",
            current: false,
            savedAt: "2025-11-18T08:05:30Z",
            savedBy: sanne,
            size: versionSize("1.0"),
          },
        ],
        nextPage: null,
      },
      provenance: [itemIds.procedure],
    });
    expect(graphPaths()).toStrictEqual([
      `${drivePath}/items/${itemIds.procedure}`,
      `${drivePath}/items/${itemIds.procedure}/versions`,
    ]);
  });

  it("page through a file's versions, the newest alone current", async () => {
    const connection = await connected();
    const pageSchema = z.object({
      versions: z.array(z.object({ id: z.string(), current: z.boolean() })),
      nextPage: z.string().nullable(),
    });
    const seen: { id: string; current: boolean }[] = [];
    let page: string | undefined;
    do {
      const read = pageSchema.parse(
        // oxlint-disable-next-line no-await-in-loop -- each page follows the last
        await outputOf(
          call(connection, "files.versions", {
            drive: financeDrive,
            item: itemIds.procedure,
            top: 1,
            ...(page === undefined ? {} : { page }),
          })
        )
      );
      seen.push(...read.versions);
      page = read.nextPage ?? undefined;
    } while (page !== undefined);
    expect(seen).toStrictEqual([
      { id: "3.0", current: true },
      { id: "2.0", current: false },
      { id: "1.0", current: false },
    ]);
  });

  it("refuse an older version too big to read before asking for its content", async () => {
    const connection = await connected();
    graph.oversizeVersion("1.0");
    await expect(
      toolError(
        call(connection, "files.read", {
          drive: financeDrive,
          item: itemIds.procedure,
          version: "1.0",
        })
      )
    ).resolves.toMatchObject({ error: { code: "too_large" } });
    expect(graphPaths()).not.toContain(
      `${drivePath}/items/${itemIds.procedure}/versions/1.0/content`
    );
  });

  it("read an older version of a file, to compare it with the current one", async () => {
    const connection = await connected();
    const procedure = { drive: financeDrive, item: itemIds.procedure };
    const [current, older] = await Promise.all([
      outputOf(call(connection, "files.read", procedure)),
      outputOf(
        call(connection, "files.read", { ...procedure, version: "1.0" })
      ),
    ]);
    expect([current, older]).toMatchObject([
      { version: null, content: procedureTexts["3.0"] },
      {
        id: itemIds.procedure,
        name: "Advice procedure.txt",
        version: "1.0",
        size: versionSize("1.0"),
        content: procedureTexts["1.0"],
      },
    ]);
    const versionPath = `${drivePath}/items/${itemIds.procedure}/versions/1.0`;
    expect(graphPaths()).toContain(`${versionPath}/content`);
    const download = graph.sent.find(({ path }) =>
      path.includes("/_vti_history/")
    );
    expect(download?.host).toBe(graph.sharePointHost);
    expect(download?.headers).not.toHaveProperty("authorization");
    // A version the file doesn't have is Graph's to refuse.
    await expect(
      toolError(
        call(connection, "files.read", { ...procedure, version: "9.0" })
      )
    ).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("give no versions of a file the person may not open, of a folder or of another drive's file", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      (
        [
          ["files.versions", { item: itemIds.locked }],
          ["files.read", { item: itemIds.locked, version: "1.0" }],
          ["files.versions", { item: itemIds.folder }],
          ["files.versions", { item: itemIds.foreign }],
        ] satisfies [string, Input][]
      ).map(
        async ([tool, input]) =>
          await toolError(
            call(connection, tool, { drive: financeDrive, ...input })
          )
      )
    );
    expect(refusals).toMatchObject([
      { error: { code: "access_denied" } },
      { error: { code: "access_denied" } },
      { error: { code: "not_a_file" } },
      { error: { code: "not_found" } },
    ]);
    // Each was refused on the file itself, before its versions were asked for.
    expect(
      graphPaths().filter((path) => path.includes("/versions"))
    ).toStrictEqual([]);
  });

  it("follow a download's redirect only to SharePoint over HTTPS, once", async () => {
    const connection = await connected();
    const outcomes = await Promise.all(
      [itemIds.elsewhere, itemIds.plain, itemIds.nested, itemIds.twice].map(
        async (item) =>
          await toolError(
            call(connection, "files.read", { drive: financeDrive, item })
          )
      )
    );
    // The egress withholds each answer, and says so.
    expect(outcomes).toMatchObject(
      Array.from({ length: 4 }, () => ({ error: { code: "egress_failed" } }))
    );
    // Only the one redirect to SharePoint itself was followed; its own
    // redirect was not.
    expect(
      graph.sent
        .map(({ host }) => host)
        .filter((host) => host !== "graph.microsoft.com")
    ).toStrictEqual([graph.sharePointHost]);
  });
});

describe("the Microsoft 365 connector's list tools", () => {
  const contracts = { site: financeSite, list: contractsList };

  it("read the items of a list that meet every condition, with only their own columns", async () => {
    const connection = await connected();
    const result = await resultOf(
      call(connection, "lists.items", {
        ...contracts,
        where: [
          { column: "Supplier", is: "eq", value: "O'Brien & Sons" },
          { column: "Amount", is: "ge", value: 5000 },
        ],
      })
    );
    // Items 3, 7, 11... are O'Brien's; from 20 on they're worth 5,000.
    const ids = Array.from({ length: contractCount }, (_, index) => index + 1)
      .filter((n) => n % 4 === 3 && n >= 20)
      .map(String);
    // Named in their list: an item's ID is unique there only.
    expect(result.provenance).toStrictEqual(
      ids.map((id) => `${contractsList}/${id}`)
    );
    expect(result.output).toMatchObject({
      site: financeSite,
      list: contractsList,
      nextPage: null,
    });
    expect(
      z
        .object({ items: z.array(z.unknown()) })
        .parse(result.output)
        .items.at(0)
    ).toStrictEqual({
      id: "23",
      fields: {
        id: "23",
        Title: "Contract 23",
        Supplier: "O'Brien & Sons",
        Status: "Open",
        Amount: 5750,
        Renewal_x0020_date: "2027-06-01T00:00:00Z",
        _x0032_nd_x0020_signatory: "Legal",
        Regions: ["EU", "UK"],
        Website: JSON.stringify({
          Description: "Supplier portal",
          Url: "https://suppliers.example.com/23",
        }),
        Modified: "2026-06-13T09:30:00Z",
        Created: "2026-01-05T08:00:00Z",
        AuthorLookupId: "11",
        EditorLookupId: "11",
        Attachments: false,
      },
      createdAt: "2026-01-05T08:00:00Z",
      lastModifiedAt: "2026-06-13T09:30:00Z",
      webUrl: `https://${graph.sharePointHost}/sites/Finance/Lists/Contracts/23_.000`,
    });
    // The filter is built from the conditions, its quote doubled as OData
    // does, and Graph is told it may filter on columns that aren't indexed.
    const [sent] = requests();
    expect(sent).toMatchObject({
      path: `/v1.0/sites/${encodeURIComponent(financeSite)}/lists/${contractsList}/items`,
      query: {
        $filter:
          "fields/Supplier eq 'O''Brien & Sons' and fields/Amount ge 5000",
      },
    });
    expect(graph.sent[0]?.headers).toMatchObject({
      prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
    });
  });

  it("read only the columns asked for, one of SharePoint's own too", async () => {
    const connection = await connected();
    const output = await outputOf(
      call(connection, "lists.items", {
        ...contracts,
        columns: ["Title", "Status", "ContentType"],
        top: 1,
      })
    );
    expect(output).toMatchObject({
      items: [
        {
          id: "1",
          fields: {
            id: "1",
            Title: "Contract 1",
            Status: "Open",
            ContentType: "Item",
          },
        },
      ],
    });
    expect(requests()[0]?.query).toMatchObject({
      $expand: "fields($select=Title,Status,ContentType)",
    });
  });

  it("take no condition that could be anything but a literal on a column", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      [
        { column: "Status eq 'Open' or Amount", is: "gt", value: 0 },
        { column: "Status", is: "eq or", value: "Open" },
      ].map(
        async (condition) =>
          await toolError(
            call(connection, "lists.items", {
              ...contracts,
              where: [condition],
            })
          )
      )
    );
    expect(refusals).toStrictEqual([
      "Invalid input: invalid_format at where.0.column",
      "Invalid input: invalid_value at where.0.is",
    ]);
    expect(graph.sent).toStrictEqual([]);
  });

  it("refuse a list in a site the person can't open, as Graph does", async () => {
    const connection = await connected();
    await expect(
      toolError(
        call(
          connection,
          "lists.items",
          { site: hrSite, list: contractsList },
          { resource: hrSite }
        )
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
  });

  it("cut a long list at its bound, and go on from there page by page", async () => {
    const connection = await connected();
    const pageSchema = z.object({
      items: z.array(z.object({ id: z.string() })),
      nextPage: z.string().nullable(),
    });
    const first = pageSchema.parse(
      await outputOf(call(connection, "lists.items", contracts))
    );
    expect({
      read: first.items.length,
      nextPage: first.nextPage,
    }).toStrictEqual({
      read: 50,
      nextPage: `%24skiptoken=${encodeURIComponent("Paged=TRUE&p_ID=50")}`,
    });
    const second = pageSchema.parse(
      await outputOf(
        call(connection, "lists.items", {
          ...contracts,
          page: first.nextPage ?? "",
        })
      )
    );
    // The rest, from where the first page ended.
    expect({
      read: second.items.map(({ id }) => Number(id)),
      nextPage: second.nextPage,
    }).toStrictEqual({
      read: Array.from(
        { length: contractCount - 50 },
        (_, index) => index + 51
      ),
      nextPage: null,
    });
    // Never more than a page's bound, whatever is asked.
    await expect(
      toolError(call(connection, "lists.items", { ...contracts, top: 500 }))
    ).resolves.toBe("Invalid input: too_big at top");
    expect(requests().map(({ query }) => query.$top)).toStrictEqual([
      "50",
      "50",
    ]);
  });
});

describe("the Microsoft 365 connector's list pages", () => {
  const contracts = { site: financeSite, list: contractsList };

  it("keep a page's conditions and columns on the next page", async () => {
    const connection = await connected();
    const asked = {
      ...contracts,
      where: [{ column: "Status", is: "eq", value: "Open" }],
      columns: ["Title", "Status"],
      top: 10,
    };
    const pageSchema = z.object({
      items: z.array(
        z.object({ id: z.string(), fields: z.record(z.string(), z.unknown()) })
      ),
      nextPage: z.string().nullable(),
    });
    const first = pageSchema.parse(
      await outputOf(call(connection, "lists.items", asked))
    );
    const second = pageSchema.parse(
      await outputOf(
        call(connection, "lists.items", {
          ...asked,
          page: first.nextPage ?? "",
        })
      )
    );
    const items = [...first.items, ...second.items];
    // Open contracts are those whose number isn't a multiple of 3.
    const open = Array.from({ length: contractCount }, (_, index) => index + 1)
      .filter((n) => n % 3 !== 0)
      .slice(0, 20)
      .map(String);
    expect({
      ids: items.map(({ id }) => id),
      columns: [
        ...new Set(items.flatMap(({ fields }) => Object.keys(fields))),
      ].toSorted(),
      statuses: [...new Set(items.map(({ fields }) => fields.Status))],
    }).toStrictEqual({
      ids: open,
      columns: ["Status", "Title", "id"],
      statuses: ["Open"],
    });
    const [, again] = requests();
    expect(again?.query).toMatchObject({
      $filter: "fields/Status eq 'Open'",
      $expand: "fields($select=Title,Status)",
      $top: "10",
    });
  });
});

const supplierNamed = (value: Input[string]) =>
  fabrikam.map((cell) =>
    cell.column === "Supplier" ? { ...cell, value } : cell
  );

/** The requests that reached Graph with `method`. */
const sentAs = (method: string): number =>
  requests().filter((request) => request.method === method).length;

// Excel registers, as company records: the ways it can fail come first. A
// call for one register reaches another (scoping, above), or a named
// range that points at any sheet; a change lands on a row that moved or
// changed since it was read; a cell from an email runs as a formula; a
// formula's value, as a row reads it, is written back over it; a day
// is written as a number nobody can read; a change leaves no record of
// what the row held; a lost answer makes it run twice.
describe("the Microsoft 365 connector's Excel tools", () => {
  const { register } = workbookIds;
  const tablePath = `${drivePath}/items/${register}/workbook/tables/${supplierTable}`;

  /** A call of `action` on the register, in a workflow run. */
  const onRegister = async (
    connection: Connection,
    action: string,
    input: Input,
    idempotencyKey?: string
  ) =>
    await call(
      connection,
      action,
      { ...supplierTableOf, workbook: register, ...input },
      { resource: register, idempotencyKey }
    );

  /** The register's supplier rows as Excel holds them, each cell's value. */
  const valuesHeld = () =>
    graph
      .supplierRowsOf(register)
      .map((row) => row.map(({ value, format }) => ({ value, format })));

  it("list a named table's rows under its columns, a day as its date, page by page", async () => {
    const connection = await connected();
    await expect(
      resultOf(onRegister(connection, "excel.listRows", { top: 1 }))
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        workbook: register,
        table: supplierTable,
        columns: supplierColumns,
        rows: [{ row: 0, values: northwind }],
        nextStart: 1,
      },
      // This page of this table: a part of the workbook of its own.
      provenance: [`${register}/${supplierTable}/0`],
    });
    await expect(
      outputOf(onRegister(connection, "excel.listRows", { start: 1 }))
    ).resolves.toMatchObject({
      rows: [{ row: 1, values: contoso }],
      nextStart: null,
    });
    // Only the named table, never a sheet or a range of one.
    expect(new Set(graphPaths())).toStrictEqual(
      new Set([`${tablePath}/headerRowRange`, `${tablePath}/dataBodyRange`])
    );
  });

  it("reach only a named table: never a named range, a table the workbook doesn't have, or another name for one", async () => {
    const connection = await connected();
    const list = async (table: string) =>
      await call(
        connection,
        "excel.listRows",
        { drive: financeDrive, workbook: register, table },
        { resource: register }
      );
    const notTables = await Promise.all(
      [totalsRange, "Invoices"].map(
        async (table) => await toolError(list(table))
      )
    );
    expect(notTables).toMatchObject([
      { error: { code: "not_found" } },
      { error: { code: "not_found" } },
    ]);
    // A range's address, a table's ID or a sheet: refused before anything
    // goes out.
    const sent = graph.sent.length;
    const others = await Promise.all(
      [
        "Suppliers!A1:D3",
        "{2C0F9E1A-7A39-4E8B-9C1D-0E5F6A7B8C9D}",
        "Sheet1/range",
      ].map(async (table) => await outcome(list(table)))
    );
    expect({ others: new Set(others), sent: graph.sent.length }).toStrictEqual({
      others: new Set(["connect.action_failed"]),
      sent,
    });
  });

  it("add a row at the end of a named table once for its key, a day stored as a date, never its serial number", async () => {
    const connection = await connected();
    const add = async () =>
      await outputOf(
        onRegister(
          connection,
          "excel.addRow",
          { values: fabrikam },
          "run-3:add"
        )
      );
    const added = await add();
    expect(added).toStrictEqual({
      drive: financeDrive,
      workbook: register,
      table: supplierTable,
      row: 2,
      values: fabrikam,
    });
    // Excel holds the day as a date: its serial number, shown as a date.
    expect(valuesHeld()[2]).toStrictEqual([
      { value: "Fabrikam Metals", format: "General" },
      { value: "NL55INGB0001234567", format: "General" },
      { value: 46_316, format: "yyyy-mm-dd" },
      { value: "", format: "General" },
    ]);
    await expect(
      outputOf(onRegister(connection, "excel.listRows", { start: 2 }))
    ).resolves.toMatchObject({ rows: [{ row: 2, values: fabrikam }] });
    // The same call again, under its key, adds nothing.
    await expect(add()).resolves.toStrictEqual(added);
    expect({ rows: valuesHeld().length, posts: sentAs("POST") }).toStrictEqual({
      rows: 3,
      posts: 1,
    });
  });

  it("refuse a row that doesn't give each of the table's columns once", async () => {
    const connection = await connected();
    const outcomes = await Promise.all(
      [
        fabrikam.slice(1),
        [...fabrikam, { column: "Notes", value: "New" }],
        [...fabrikam.slice(1), ...fabrikam.slice(1, 2)],
      ].map(
        async (values) =>
          await toolError(
            onRegister(
              connection,
              "excel.addRow",
              { values },
              crypto.randomUUID()
            )
          )
      )
    );
    expect(outcomes).toMatchObject([
      { error: { code: "invalid" } },
      { error: { code: "invalid" } },
      { error: { code: "invalid" } },
    ]);
    expect(sentAs("POST")).toBe(0);
  });

  it("refuse text that would run as a formula, and a formula its person didn't confirm", async () => {
    const connection = await connected();
    const refused = await Promise.all(
      [
        '=HYPERLINK("https://pay.example.net","Pay now")',
        "@SUM(A1:A9)",
        "+cmd",
        "-Contoso",
        { formula: "=SUM(1,2)" },
      ].map(
        async (value) =>
          await toolError(
            onRegister(
              connection,
              "excel.addRow",
              { values: supplierNamed(value) },
              crypto.randomUUID()
            )
          )
      )
    );
    expect(refused).toMatchObject(
      Array.from({ length: 5 }, () => ({ error: { code: "invalid" } }))
    );
    expect(sentAs("POST")).toBe(0);
    // A minus before a number is a number, as Excel takes it.
    await expect(
      outputOf(
        onRegister(
          connection,
          "excel.addRow",
          { values: withAmount(fabrikam, "-12.5") },
          "run-3:credit"
        )
      )
    ).resolves.toMatchObject({ values: withAmount(fabrikam, -12.5) });
  });

  it("change a row only while it holds what was read, keeping its old and new values for audit", async () => {
    const connection = await connected();
    const update = async (before: SupplierRow, amount: number, key: string) =>
      await onRegister(
        connection,
        "excel.updateRow",
        { row: 0, before, after: withAmount(northwind, amount) },
        key
      );
    await expect(
      outputOf(update(northwind, 1350, "run-4:raise"))
    ).resolves.toStrictEqual({
      drive: financeDrive,
      workbook: register,
      table: supplierTable,
      row: 0,
      before: northwind,
      after: withAmount(northwind, 1350),
    });
    // The old and new values are kept, and the call's audit event vouches
    // for them by their hash.
    const kept = await drizzle(env.DB)
      .select()
      .from(callChanges)
      .where(eq(callChanges.connectionId, connection.id));
    const [change] = kept;
    const text = change?.change ?? "";
    const values: unknown = JSON.parse(text);
    expect({
      kept: kept.length,
      change: values,
      hash: change?.hash,
    }).toStrictEqual({
      kept: 1,
      change: { before: northwind, after: withAmount(northwind, 1350) },
      hash: await sha256Hex(text),
    });
    const events = await audit.events();
    expect(
      events.find(({ action }) => action === "connection.call")
    ).toMatchObject({
      requestId: change?.requestId,
      detail: { action: "excel.updateRow", changeHash: change?.hash },
    });
    // A change made from what the row held before is refused, unwritten.
    await expect(
      toolError(update(northwind, 999, "run-4:stale"))
    ).resolves.toMatchObject({ error: { code: "conflict" } });
    // One asking for what the row already holds writes nothing, and keeps
    // no change: the `before` it names was never seen in the row.
    const again = await outputOf(
      update(withAmount(northwind, 5), 1350, "run-4:again")
    );
    const keptAfter = await drizzle(env.DB)
      .select()
      .from(callChanges)
      .where(eq(callChanges.connectionId, connection.id));
    expect({
      amount: valuesHeld()[0]?.[3]?.value,
      again,
      kept: keptAfter.length,
      patches: sentAs("PATCH"),
    }).toStrictEqual({
      amount: 1350,
      again: {
        drive: financeDrive,
        workbook: register,
        table: supplierTable,
        row: 0,
        before: withAmount(northwind, 5),
        after: withAmount(northwind, 1350),
      },
      kept: 1,
      patches: 1,
    });
  });

  it("refuse a change whose read cell has since changed type, though it reads the same", async () => {
    const connection = await connected();
    // Read as text "1200", it now holds the number 1200.
    await expect(
      toolError(
        onRegister(
          connection,
          "excel.updateRow",
          {
            row: 0,
            before: withAmount(northwind, "1200"),
            after: withAmount(northwind, 1350),
          },
          "run-7:typed"
        )
      )
    ).resolves.toMatchObject({ error: { code: "conflict" } });
    expect(sentAs("PATCH")).toBe(0);
  });

  it("recover a change that empties a cell, finding the row as it was asked to stand", async () => {
    const connection = await connected();
    const iban = "NL20INGB0001234567";
    const update = async () =>
      await onRegister(
        connection,
        "excel.updateRow",
        {
          row: 0,
          before: northwind,
          after: withIban(withAmount(northwind, ""), iban),
        },
        "run-7:clear"
      );
    graph.loseWriteAnswer();
    await expect(outcome(update())).resolves.toBe("connect.outcome_unknown");
    await claimedAgo(connection);
    await expect(outputOf(update())).resolves.toMatchObject({
      after: withIban(withAmount(northwind, null), iban),
    });
    expect(sentAs("PATCH")).toBe(1);
  });

  it("never write a formula's value over it: a change keeps the formula a cell holds, unconfirmed, or is refused", async () => {
    const connection = await connected();
    graph.typeFormula(register, {
      row: 0,
      column: 3,
      formula: "=1200*1.1",
      value: 1320,
    });
    // The row reads the formula's cell as its value.
    const read = withAmount(northwind, 1320);
    await expect(
      outputOf(onRegister(connection, "excel.listRows", { top: 1 }))
    ).resolves.toMatchObject({ rows: [{ row: 0, values: read }] });
    const change = async (after: SupplierRow, key: string) =>
      await onRegister(
        connection,
        "excel.updateRow",
        { row: 0, before: read, after },
        key
      );
    const iban = "NL20INGB0001234567";
    // Given back as that value, it would be written over the formula.
    await expect(
      toolError(change(withIban(read, iban), "run-6:iban"))
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    // Given as the formula the cell holds, a run writes the row without
    // its person confirming it again.
    const kept = withIban(
      withAmount(northwind, { formula: "=1200*1.1" }),
      iban
    );
    await expect(
      outputOf(change(kept, "run-6:iban-kept"))
    ).resolves.toMatchObject({ after: kept });
    const [first] = graph.supplierRowsOf(register);
    expect({
      iban: first?.[1]?.value,
      amount: first?.[3]?.formula,
      patches: sentAs("PATCH"),
    }).toStrictEqual({ iban, amount: "=1200*1.1", patches: 1 });
  });

  it("recover a row change whose answer was lost by finding it written, never writing twice; an added row's stays unknown", async () => {
    const connection = await connected();
    const update = async () =>
      await onRegister(
        connection,
        "excel.updateRow",
        { row: 0, before: northwind, after: withAmount(northwind, 1350) },
        "run-5:raise"
      );
    graph.loseWriteAnswer();
    await expect(outcome(update())).resolves.toBe("connect.outcome_unknown");
    // Once its claim has timed out, the same call recovers it: the row
    // already stands as asked, and nothing is written again.
    await claimedAgo(connection);
    await expect(outputOf(update())).resolves.toMatchObject({
      after: withAmount(northwind, 1350),
    });
    // An added row carries nothing to find it by: it stays unknown.
    const add = async () =>
      await outcome(
        onRegister(
          connection,
          "excel.addRow",
          { values: fabrikam },
          "run-5:add"
        )
      );
    graph.loseWriteAnswer();
    const first = await add();
    await claimedAgo(connection);
    expect([first, await add()]).toStrictEqual([
      "connect.outcome_unknown",
      "connect.outcome_unknown",
    ]);
    expect({
      patches: sentAs("PATCH"),
      posts: sentAs("POST"),
      done: graph.writesDone(),
      rows: valuesHeld().length,
    }).toStrictEqual({ patches: 1, posts: 1, done: 2, rows: 3 });
  });

  it("hold a row change from chat on a card with its old and new values, and write it, a formula too, once its person confirms", async () => {
    const connection = await connected();
    const { person } = connection;
    const chat = agentFor(person.userId, "agent-chat", "interactive");
    const after = withAmount(northwind, { formula: "=1200*1.1" });
    const asked = await callAs(
      chat,
      {
        connectionId: connection.id,
        resource: register,
        action: "excel.updateRow",
        input: {
          ...supplierTableOf,
          workbook: register,
          row: 0,
          before: northwind,
          after,
        },
        idempotencyKey: `chat-1:${crypto.randomUUID()}`,
      },
      { origin: chatOrigin }
    );
    const waiting: PendingAction[] =
      await exports.default.listPendingActions(person);
    expect({
      held: asked.pending?.id,
      sent: graph.sent.length,
      descriptions: waiting.map(({ id, description }) => ({ id, description })),
    }).toStrictEqual({
      held: waiting[0]?.id,
      sent: 0,
      descriptions: [
        {
          id: asked.pending?.id,
          description: {
            title: "Change a row of an Excel table",
            fields: [
              { input: "drive", label: "Drive", value: financeDrive },
              { input: "workbook", label: "Workbook", value: register },
              { input: "table", label: "Table", value: supplierTable },
              { input: "row", label: "Row", value: "0" },
              {
                input: "before",
                label: "Now",
                value: JSON.stringify(northwind, null, 2),
              },
              {
                input: "after",
                label: "Will be",
                value: JSON.stringify(after, null, 2),
              },
            ],
            complete: true,
          },
        },
      ],
    });
    const [held] = waiting;
    if (held === undefined) {
      throw new Error("Expected the held change");
    }
    const confirm = async () =>
      await exports.default.confirmAction({
        person,
        id: held.id,
        inputHash: held.inputHash,
        capability: await signCapability(env.CAPABILITY_SIGNING_KEY, chat, {
          connectionId: connection.id,
          resource: register,
          action: held.action,
          idempotencyKey: held.idempotencyKey,
          origin: chatOrigin,
          decision: { kind: "confirm", pendingActionId: held.id },
        }),
      });
    await expect(outputOf(confirm())).resolves.toMatchObject({
      before: northwind,
      after,
    });
    await expect(outcome(confirm())).resolves.not.toBe("ok");
    // The formula its person confirmed is the cell's, written once.
    expect({
      amount: graph.supplierRowsOf(register)[0]?.[3]?.formula,
      patches: sentAs("PATCH"),
    }).toStrictEqual({ amount: "=1200*1.1", patches: 1 });
  });
});

const list = async (connection: Connection) =>
  await call(
    connection,
    "excel.listRows",
    { ...supplierTableOf, workbook: workbookIds.register },
    { resource: workbookIds.register }
  );

describe("the Microsoft 365 connector's right to change files", () => {
  /** What Entra granted a connection made before workbooks were written. */
  const grantedBefore =
    "openid profile email User.Read Mail.ReadWrite Mail.ReadWrite.Shared Mail.Send Mail.Send.Shared Calendars.Read Calendars.Read.Shared Files.Read.All Sites.Read.All";

  it("keeps a connection whose renewal holds it, by Graph's full name too", async () => {
    const connection = await connected();
    providers.state.refreshGranted = `${grantedBefore} https://graph.microsoft.com/Files.ReadWrite.All`;
    await expire(connection);
    await expect(outcome(list(connection))).resolves.toBe("ok");
    await expect(statusOf(connection)).resolves.toBe("active");
  });

  it("marks a connection made without it for reconnecting, which gives it back in place", async () => {
    const connection = await connected();
    providers.state.refreshGranted = grantedBefore;
    await expire(connection);
    await expect(outcome(list(connection))).resolves.toBe(
      "connect.connection_inactive"
    );
    const events = await audit.events();
    expect({
      sent: graph.sent.length,
      status: await statusOf(connection),
      marked: events
        .filter(({ action }) => action === "connection.needs_reauth")
        .map(({ detail }) => detail),
    }).toStrictEqual({
      sent: 0,
      status: "needs_reauth",
      marked: [{ provider: "microsoft", reason: "scopes_missing" }],
    });
    // Its person connects again, consenting to the right: the same
    // connection, so every permission on it stands.
    providers.state.refreshGranted = undefined;
    await expect(
      connectAccount(
        providers,
        connection.person,
        ownAccount(connection.person)
      )
    ).resolves.toBe(connection.id);
    await expect(outcome(list(connection))).resolves.toBe("ok");
  });
});
