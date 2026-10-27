/**
 * Google's APIs for Stephen's eval on Google Workspace
 * (stephen-eval-google.test.ts): a person's Gmail and Google Calendar, the
 * files of a shared drive, and a company's spreadsheets, as the Google
 * Workspace connector's reads ask for them, in the shapes Gmail v1,
 * Calendar v3, Drive v3 and Sheets v4 document. Calendar times come back
 * in UTC, as the connector asks for them (`timeZone=UTC`), and a day in a
 * sheet as Sheets' serial number with a date format, which the connector
 * reads as the sheet shows it. A test sets a mailbox's world, a drive's
 * files and a spreadsheet's sheets by POSTing to the control URL; it
 * answers only for those, so every other test's Google stays as it was.
 * Every read of a world is kept, its path and query as written, and every
 * write is kept and never carried out, for the eval's first hard rule:
 * nothing runs in the turn. `{ failNext: "events" }` has the next calendar
 * read fail, as Google sometimes does.
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (test/connect-providers.ts embeds its source).
 */
export const stephenGoogleFake = () => {
  /** A mailbox's calendar (its address) and mail, as Google holds them. */
  interface World {
    events: Record<string, unknown>[];
    messages: Record<string, unknown>[];
  }
  /** A file of a shared drive: a spreadsheet's text is its first sheet. */
  interface File {
    id: string;
    name: string;
    mimeType: string;
    text: string;
  }
  /** A spreadsheet's sheets, each its rows of Sheets' grid cells. */
  interface Spreadsheet {
    name: string;
    sheets: { title: string; rows: unknown[][] }[];
  }
  const worlds = new Map<string, World>();
  const drives = new Map<string, File[]>();
  const spreadsheets = new Map<string, Spreadsheet>();
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
      ? Date.parse(String(time.dateTime))
      : Number.NaN;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const notFound = () =>
    Response.json(
      {
        error: {
          code: 404,
          status: "NOT_FOUND",
          errors: [{ reason: "notFound", message: "Not Found" }],
        },
      },
      { status: 404 }
    );
  /** Whether any word of a search (longer than two letters) is in `value`. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const matches = (value: unknown, search: string) => {
    const words = search
      .replaceAll(/["']/gu, "")
      .toLowerCase()
      .split(/\s+/u)
      .filter((word) => word.length > 2 && !word.includes(":"));
    const text = JSON.stringify(value).toLowerCase();
    return words.length === 0 || words.some((word) => text.includes(word));
  };
  /** A message as `format=metadata` gives it: its headers, no body. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const metadataOf = (message: Record<string, unknown>) => {
    const { payload, ...rest } = message;
    const headers =
      typeof payload === "object" && payload !== null && "headers" in payload
        ? payload.headers
        : [];
    return { ...rest, payload: { mimeType: "text/plain", headers } };
  };

  const gmailAnswer = (
    world: World,
    method: string,
    rest: string[],
    url: URL
  ): Response => {
    const [collection, id] = rest;
    if (method === "GET" && collection === "messages" && id === undefined) {
      const found = world.messages.filter((message) =>
        matches(message, url.searchParams.get("q") ?? "")
      );
      return Response.json({
        messages: found.map((message) => ({
          id: message.id,
          threadId: message.threadId,
        })),
        resultSizeEstimate: found.length,
      });
    }
    if (method === "GET" && collection === "messages") {
      const message = world.messages.find((each) => each.id === id);
      if (message === undefined) {
        return notFound();
      }
      return Response.json(
        url.searchParams.get("format") === "metadata"
          ? metadataOf(message)
          : message
      );
    }
    return notFound();
  };

  const calendarAnswer = (
    world: World,
    method: string,
    rest: string[],
    url: URL
  ): Response => {
    const [collection, id] = rest;
    if (method === "GET" && collection === "events" && id === undefined) {
      const from = Date.parse(url.searchParams.get("timeMin") ?? "");
      const to = Date.parse(url.searchParams.get("timeMax") ?? "");
      return Response.json({
        kind: "calendar#events",
        timeZone: "UTC",
        items: world.events
          .filter(
            (event) => timeOf(event.start) < to && timeOf(event.end) > from
          )
          .toSorted((one, other) => timeOf(one.start) - timeOf(other.start)),
      });
    }
    if (method === "GET" && collection === "events") {
      const event = world.events.find((each) => each.id === id);
      return event === undefined ? notFound() : Response.json(event);
    }
    return notFound();
  };

  /** A drive file's metadata, as `fields` asks for it. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const metadataOfFile = (drive: string, file: File) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    ...(file.mimeType.startsWith("application/vnd.google-apps.")
      ? {}
      : { size: String(new TextEncoder().encode(file.text).byteLength) }),
    parents: [drive],
    driveId: drive,
    trashed: false,
  });

  /** The drive and file of a file ID, if a drive holds it. */
  const fileById = (id: string) =>
    [...drives]
      .flatMap(([drive, files]) =>
        files.filter((file) => file.id === id).map((file) => ({ drive, file }))
      )
      .at(0);

  const driveAnswer = (rest: string[], url: URL): Response | undefined => {
    const [id, more] = rest;
    if (id === undefined) {
      const drive = url.searchParams.get("driveId") ?? "";
      const files = drives.get(drive);
      if (files === undefined) {
        return undefined;
      }
      // `'{folder}' in parents`, or `fullText contains '{query}'`.
      const q = url.searchParams.get("q") ?? "";
      const query = /fullText contains '(?<query>(?:[^'\\]|\\.)*)'/u.exec(q)
        ?.groups?.query;
      const found =
        query === undefined
          ? files
          : files.filter((file) => matches(`${file.name} ${file.text}`, query));
      return Response.json({
        files: found.map((file) => metadataOfFile(drive, file)),
      });
    }
    const held = fileById(id);
    if (held === undefined) {
      return undefined;
    }
    if (more === "export" || url.searchParams.get("alt") === "media") {
      return new Response(held.file.text, {
        headers: {
          "content-type": more === "export" ? "text/csv" : held.file.mimeType,
        },
      });
    }
    return Response.json(metadataOfFile(held.drive, held.file));
  };

  const sheetsAnswer = (id: string, url: URL): Response | undefined => {
    const spreadsheet = spreadsheets.get(id);
    if (spreadsheet === undefined) {
      return undefined;
    }
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
    const properties = (title: string, index: number) => ({ title, index });
    if (url.searchParams.get("includeGridData") !== "true") {
      return Response.json({
        spreadsheetId: id,
        properties: { title: spreadsheet.name },
        sheets: spreadsheet.sheets.map(({ title }, index) => ({
          properties: properties(title, index),
        })),
      });
    }
    // `'{sheet}'!{rows}`: the sheet's rows from the top, as many as asked.
    const range = url.searchParams.get("ranges") ?? "";
    const parsed = /^'(?<title>(?:[^']|'')*)'!(?:\d+:(?<last>\d+))?/u.exec(
      range
    )?.groups;
    const title = (parsed?.title ?? "").replaceAll("''", "'");
    const index = spreadsheet.sheets.findIndex(
      (sheet) => sheet.title === title
    );
    const sheet = spreadsheet.sheets[index];
    if (sheet === undefined) {
      return Response.json(
        { error: { code: 400, status: "INVALID_ARGUMENT" } },
        { status: 400 }
      );
    }
    const last = Number(parsed?.last ?? sheet.rows.length);
    return Response.json({
      sheets: [
        {
          properties: properties(sheet.title, index),
          data: [
            {
              rowData: sheet.rows.slice(0, last).map((values) => ({ values })),
            },
          ],
        },
      ],
    });
  };

  /** Google's answer for a world's request, or `undefined` for the rest. */
  const route = (
    request: Request,
    url: URL
  ): (() => Response | undefined) | undefined => {
    const parts = decodeURIComponent(url.pathname).split("/");
    if (url.hostname === "gmail.googleapis.com" && parts[3] === "users") {
      const world = worlds.get((parts[4] ?? "").toLowerCase());
      return world === undefined
        ? undefined
        : () => gmailAnswer(world, request.method, parts.slice(5), url);
    }
    if (url.hostname === "www.googleapis.com" && parts[1] === "calendar") {
      // /calendar/v3/calendars/{calendar}/events[/{event}], or the
      // person's own entry, /calendar/v3/users/me/calendarList/{calendar}.
      const own = parts[3] === "users";
      const calendar = (parts[own ? 6 : 4] ?? "").toLowerCase();
      const world = worlds.get(calendar);
      if (world === undefined) {
        return undefined;
      }
      return own
        ? () => Response.json({ id: calendar, primary: true })
        : () => calendarAnswer(world, request.method, parts.slice(5), url);
    }
    if (url.hostname === "www.googleapis.com" && parts[1] === "drive") {
      // /drive/v3/files[/{file}[/export]]
      const answered = driveAnswer(parts.slice(4), url);
      return answered === undefined ? undefined : () => answered;
    }
    if (
      url.hostname === "sheets.googleapis.com" &&
      parts[2] === "spreadsheets"
    ) {
      const answered = sheetsAnswer(parts[3] ?? "", url);
      return answered === undefined ? undefined : () => answered;
    }
    return undefined;
  };

  return {
    /**
     * POST `{ mailbox, events, messages }` to set a mailbox's world (its
     * calendar is its address), `{ drive, files }` a shared drive's files
     * (each `{ id, name, mimeType, text }`), `{ spreadsheet, drive, name,
     * sheets }` a spreadsheet in a shared drive (each sheet `{ title, rows
     * }`, a row Sheets' grid cells), or `{ failNext }`; GET reads what
     * reached them.
     */
    control: async (request: Request): Promise<Response> => {
      if (request.method === "GET") {
        return Response.json({ reads, writes });
      }
      const set: Record<string, unknown> = await request.json();
      const { failNext: failing, mailbox, drive, spreadsheet } = set;
      if (typeof failing === "string") {
        failNext = failing;
      }
      if (typeof mailbox === "string") {
        worlds.set(mailbox.toLowerCase(), {
          events: recordsOf(set.events),
          messages: recordsOf(set.messages),
        });
      }
      if (typeof drive === "string" && typeof spreadsheet !== "string") {
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
      if (typeof drive === "string" && typeof spreadsheet === "string") {
        const sheets = recordsOf(set.sheets).map((sheet) => ({
          title: textOf(sheet.title),
          rows: listOf(sheet.rows).map(listOf),
        }));
        spreadsheets.set(spreadsheet, { name: textOf(set.name), sheets });
        const file = {
          id: spreadsheet,
          name: textOf(set.name),
          mimeType: "application/vnd.google-apps.spreadsheet",
          text: "",
        };
        drives.set(drive, [
          ...(drives.get(drive) ?? []).filter(({ id }) => id !== spreadsheet),
          file,
        ]);
      }
      return new Response(null, { status: 204 });
    },
    /** Google's answer for a world's mailbox, calendar, drive or spreadsheet; none for the rest. */
    answer: async (
      request: Request,
      url: URL
    ): Promise<Response | undefined> => {
      const answer = route(request, url);
      if (answer === undefined) {
        return undefined;
      }
      if (request.method !== "GET") {
        writes.push({
          method: request.method,
          path: url.pathname,
          body: await request.text(),
        });
        return Response.json({ id: `written${writes.length}` });
      }
      reads.push(decodeURIComponent(url.pathname + url.search));
      if (failNext !== undefined && url.pathname.endsWith(`/${failNext}`)) {
        failNext = undefined;
        return Response.json(
          {
            error: {
              code: 503,
              status: "UNAVAILABLE",
              errors: [{ reason: "backendError", message: "Backend Error" }],
            },
          },
          { status: 503 }
        );
      }
      return answer();
    },
  };
};
