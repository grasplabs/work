/**
 * Microsoft Graph for Stephen's eval (stephen-eval.test.ts): a person's
 * Outlook calendar and mail, their OneDrive's files, and a company's Excel
 * workbooks, as the
 * Microsoft 365 connector's reads ask for them, in the shapes Graph's v1.0
 * reference documents. Calendar times come back in UTC, as the connector
 * asks for them (`Prefer: outlook.timezone="UTC"`), and a day in a workbook
 * as Excel's serial number, with its number format: the traps a turn has
 * to get through. A test sets a mailbox's world and a workbook's table by
 * POSTing to the control URL; it answers only for those, so every other
 * test's Graph stays as it was. Every read of a world is kept, its path
 * and query, and every write is kept and never carried out, for the
 * eval's first hard rule: nothing runs in the turn. `{ failNext:
 * "calendarView" }` has the next calendar read fail, as Graph sometimes
 * does.
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (test/connect-providers.ts embeds its source).
 */
export const stephenGraphFake = () => {
  /** A mailbox's calendar and mail, as Graph holds them. */
  interface World {
    events: Record<string, unknown>[];
    messages: Record<string, unknown>[];
  }
  /** A named table: its header row, and its body as Graph answers ranges. */
  interface Table {
    columns: string[];
    values: unknown[][];
    numberFormat: string[][];
  }
  /** A file of a drive: its name, type and text. */
  interface File {
    id: string;
    name: string;
    mimeType: string;
    text: string;
  }
  const worlds = new Map<string, World>();
  const drives = new Map<string, File[]>();
  const tables = new Map<string, Table>();
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const listOf = (value: unknown): unknown[] =>
    Array.isArray(value) ? value.map((item: unknown) => item) : [];
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const textOf = (value: unknown): string =>
    typeof value === "string" ? value : "";
  const recordsOf = (value: unknown): Record<string, unknown>[] =>
    listOf(value).flatMap((item) =>
      typeof item === "object" && item !== null
        ? [Object.fromEntries(Object.entries(item))]
        : []
    );
  /** Every read and write that reached a world, in order. */
  const reads: string[] = [];
  const writes: { method: string; path: string; body: string }[] = [];
  /** The kind of read that fails next, once. */
  let failNext: string | undefined;

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const timeOf = (time: unknown): number =>
    typeof time === "object" && time !== null && "dateTime" in time
      ? Date.parse(`${String(time.dateTime).slice(0, 19)}Z`)
      : Number.NaN;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const notFound = () =>
    Response.json(
      {
        error: {
          code: "ErrorItemNotFound",
          message: "The specified object was not found in the store.",
        },
      },
      { status: 404 }
    );
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const summaryOf = (message: Record<string, unknown>) => {
    const { body, ...summary } = message;
    const text =
      typeof body === "object" && body !== null && "content" in body
        ? String(body.content)
        : "";
    return { ...summary, bodyPreview: text.slice(0, 255) };
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const matches = (message: Record<string, unknown>, search: string) => {
    const words = search
      .replaceAll('"', "")
      .toLowerCase()
      .split(/\s+/u)
      .filter((word) => word.length > 2);
    const text = JSON.stringify(message).toLowerCase();
    return words.length === 0 || words.some((word) => text.includes(word));
  };

  const mailboxAnswer = (
    world: World,
    method: string,
    rest: string[],
    url: URL
  ): Response => {
    const [collection, id, more] = rest;
    if (method === "GET" && collection === "calendarView") {
      const from = Date.parse(url.searchParams.get("startDateTime") ?? "");
      const to = Date.parse(url.searchParams.get("endDateTime") ?? "");
      return Response.json({
        value: world.events
          .filter(
            (event) => timeOf(event.start) < to && timeOf(event.end) > from
          )
          .toSorted((one, other) => timeOf(one.start) - timeOf(other.start))
          .map(summaryOf),
      });
    }
    if (method === "GET" && collection === "events" && id !== undefined) {
      const event = world.events.find((each) => each.id === id);
      return event === undefined ? notFound() : Response.json(event);
    }
    const listed =
      collection === "messages" && id === undefined
        ? true
        : collection === "mailFolders" && more === "messages";
    if (method === "GET" && listed) {
      const search = url.searchParams.get("$search") ?? "";
      return Response.json({
        value: world.messages
          .filter((message) => matches(message, search))
          .map(summaryOf),
      });
    }
    if (method === "GET" && collection === "messages" && id !== undefined) {
      if (more === "attachments") {
        return Response.json({ value: [] });
      }
      const message = world.messages.find((each) => each.id === id);
      return message === undefined ? notFound() : Response.json(message);
    }
    return notFound();
  };

  const driveAnswer = (
    drive: string,
    files: readonly File[],
    rest: string[]
  ): Response => {
    const itemOf = ({ id, name, mimeType, text }: File) => ({
      id,
      name,
      size: new TextEncoder().encode(text).byteLength,
      file: { mimeType },
      parentReference: { driveId: drive, id: "root" },
    });
    const [where, what, more] = rest;
    // root/children, or root/search(q='...'): every file, or those named.
    if (where === "root" && what !== undefined) {
      const query = /^search\(q='(?<query>.*)'\)$/u.exec(what)?.groups?.query;
      const found =
        query === undefined
          ? files
          : files.filter((file) =>
              query
                .toLowerCase()
                .split(/\s+/u)
                .some((word) =>
                  `${file.name} ${file.text}`.toLowerCase().includes(word)
                )
            );
      return Response.json({ value: found.map(itemOf) });
    }
    const file = files.find(({ id }) => where === "items" && id === what);
    if (file === undefined) {
      return notFound();
    }
    return more === "content"
      ? new Response(file.text, { headers: { "content-type": file.mimeType } })
      : Response.json(itemOf(file));
  };

  const tableAnswer = (table: Table, range: string | undefined): Response => {
    if (range === "headerRowRange") {
      return Response.json({ values: [table.columns] });
    }
    if (range === "dataBodyRange") {
      return Response.json({
        values: table.values,
        numberFormat: table.numberFormat,
      });
    }
    return notFound();
  };

  return {
    /**
     * POST `{ mailbox, events, messages }` to set a mailbox's world,
     * `{ drive, files }` a drive's files (each `{ id, name, mimeType,
     * text }`), `{ table: "drive/item/name", columns, values, numberFormat }`
     * a workbook's table, or `{ failNext }`; GET reads what reached them.
     */
    control: async (request: Request): Promise<Response> => {
      if (request.method === "GET") {
        return Response.json({ reads, writes });
      }
      const set: Record<string, unknown> = await request.json();
      const { failNext: failing, mailbox, table, drive } = set;
      if (typeof failing === "string") {
        failNext = failing;
      }
      if (typeof mailbox === "string") {
        worlds.set(mailbox.toLowerCase(), {
          events: recordsOf(set.events),
          messages: recordsOf(set.messages),
        });
      }
      if (typeof drive === "string") {
        drives.set(
          drive,
          recordsOf(set.files).map((file) => ({
            id: textOf(file.id),
            name: textOf(file.name),
            mimeType: textOf(file.mimeType),
            text: textOf(file.text),
          }))
        );
      }
      if (typeof table === "string") {
        tables.set(table, {
          columns: listOf(set.columns).map(String),
          values: listOf(set.values).map(listOf),
          numberFormat: listOf(set.numberFormat).map((row) =>
            listOf(row).map(String)
          ),
        });
      }
      return new Response(null, { status: 204 });
    },
    /** Graph's answer for a world's mailbox or workbook; none for the rest. */
    answer: async (
      request: Request,
      url: URL
    ): Promise<Response | undefined> => {
      const parts = decodeURIComponent(url.pathname).split("/");
      const [, version, kind] = parts;
      if (version !== "v1.0") {
        return undefined;
      }
      let answer: () => Response;
      if (kind === "users") {
        const world = worlds.get((parts[3] ?? "").toLowerCase());
        if (world === undefined) {
          return undefined;
        }
        answer = () =>
          mailboxAnswer(world, request.method, parts.slice(4), url);
      } else if (kind === "drives" && drives.has(parts[3] ?? "")) {
        // /v1.0/drives/{drive}/root/... or /v1.0/drives/{drive}/items/{item}[/content]
        const drive = parts[3] ?? "";
        const files = drives.get(drive) ?? [];
        answer = () => driveAnswer(drive, files, parts.slice(4));
      } else if (kind === "drives" && parts[7] === "tables") {
        // /v1.0/drives/{drive}/items/{item}/workbook/tables/{name}/{range}
        const table = tables.get(`${parts[3]}/${parts[5]}/${parts[8]}`);
        if (table === undefined) {
          return undefined;
        }
        answer = () => tableAnswer(table, parts[9]);
      } else {
        return undefined;
      }
      if (request.method !== "GET") {
        writes.push({
          method: request.method,
          path: url.pathname,
          body: await request.text(),
        });
        return Response.json(
          { id: `written-${writes.length}` },
          {
            status: 201,
          }
        );
      }
      reads.push(url.pathname + url.search);
      if (failNext !== undefined && url.pathname.endsWith(`/${failNext}`)) {
        failNext = undefined;
        return Response.json(
          {
            error: {
              code: "ErrorInternalServerError",
              message:
                "An internal server error occurred. The operation failed.",
            },
          },
          { status: 500 }
        );
      }
      return answer();
    },
  };
};
