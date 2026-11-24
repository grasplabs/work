import { effectKeyPattern } from "@grasp-os/connector-kit/manifest";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";

import { connectAccount, outcome, ownAccount, someone } from "./connect.ts";
import { financeDrive, personalDrive } from "./fixtures/graph.ts";
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

// files.createDraft against the fake Graph, through connect's real call
// path: a draft lands only in the "Drafts from Stephen" folder of the
// person's own OneDrive. What can go wrong, first: a call pointed at a
// SharePoint site, a colleague's drive or a path of its own, a name
// already taken, a lost answer made twice, and a file at the draft's name
// that isn't the call's.

const providers = fakeProviders();
const graph = fakeGraph();

const folder = "Drafts from Stephen";

/** Someone's Microsoft 365 connection, made through OAuth. */
const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(providers, person, ownAccount(person));
  return { id, person };
};

const letter = {
  name: "Policy 2026-0418 for Mr de Vries",
  format: "word",
  text: "Dear Mr de Vries,\n\nYour policy 2026-0418 renews on 1 December.\n  Kind regards,",
} as const;

const note = {
  name: "Summary of the renewal call",
  format: "text",
  text: "Renewal agreed; send the new terms by Friday.",
} as const;

const draft = async (
  connection: Connection,
  input: Input,
  idempotencyKey = crypto.randomUUID()
) => await call(connection, "files.createDraft", input, { idempotencyKey });

/** The requests that reached Graph, parsed. */
const requests = () =>
  parsedRequests(graph.sent).filter(
    ({ host }) => host === "graph.microsoft.com"
  );

const writes = () => requests().filter(({ method }) => method !== "GET");

/** A Word document's parts, as text. */
const partsOf = (bytes: Uint8Array | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(unzipSync(bytes ?? new Uint8Array())).map(([name, part]) => [
      name,
      strFromU8(part),
    ])
  );

const keyIn = /<vt:lpwstr>(?<key>[^<]*)<\/vt:lpwstr>/u;

describe("files.createDraft", () => {
  it("never writes to a SharePoint site, a colleague's drive or a path of its own", async () => {
    const connection = await connected();
    const refused = await Promise.all(
      [
        { ...letter, drive: financeDrive },
        { ...letter, drive: personalDrive },
        { ...letter, folder: "Shared Documents" },
        { ...letter, name: "../../drives/b!abc/root:/Letter" },
        { ...letter, name: "Letters/Letter" },
        { ...letter, name: "Letter:/content" },
        { ...letter, name: "%2e%2e" },
        { ...letter, name: ".." },
        { ...letter, name: "~$Letter" },
        { ...letter, format: "html" },
      ].map(async (input) => await toolError(draft(connection, input)))
    );
    // Each refused by its input's schema, before anything went out.
    expect(
      refused.filter(
        (error) =>
          !(typeof error === "string" && error.startsWith("Invalid input"))
      )
    ).toStrictEqual([]);
    expect(graph.sent).toStrictEqual([]);
  });

  it("writes a Word draft to the drafts folder of the person's own OneDrive, carrying its call's key", async () => {
    const connection = await connected();
    const made = await outputOf(draft(connection, letter, "run-1:letter"));
    const parts = partsOf(graph.ownFile(`${folder}/${letter.name}.docx`));
    expect(made).toMatchObject({
      folder,
      name: `${letter.name}.docx`,
    });
    expect(writes()).toMatchObject([
      {
        method: "PUT",
        path: `/v1.0/me/drive/root:/${encodeURIComponent(folder)}/${encodeURIComponent(`${letter.name}.docx`)}:/content`,
        query: { "@microsoft.graph.conflictBehavior": "fail" },
      },
    ]);
    // Each line a paragraph, its spaces kept, and its key a custom
    // document property Word keeps on save.
    expect(parts["word/document.xml"]).toContain(
      '<w:p><w:r><w:t xml:space="preserve">Dear Mr de Vries,</w:t></w:r></w:p><w:p/>'
    );
    expect(parts["word/document.xml"]).toContain(
      '<w:t xml:space="preserve">  Kind regards,</w:t>'
    );
    expect(keyIn.exec(parts["docProps/custom.xml"] ?? "")?.groups?.key).toMatch(
      effectKeyPattern
    );
  });

  it("writes a text draft as exactly its text, in UTF-8", async () => {
    const connection = await connected();
    const made = await outputOf(
      draft(connection, { ...note, text: "Grüße, Jürgen" })
    );
    expect(made).toMatchObject({ folder, name: `${note.name}.txt` });
    expect(graph.ownFile(`${folder}/${note.name}.txt`)).toStrictEqual(
      new TextEncoder().encode("Grüße, Jürgen")
    );
  });

  it("never replaces a file already at the draft's name", async () => {
    const connection = await connected();
    const theirs = new TextEncoder().encode("The person's own notes");
    graph.putOwnFile(`${folder}/${note.name}.txt`, theirs);
    await expect(toolError(draft(connection, note))).resolves.toMatchObject({
      error: { code: "invalid" },
    });
    expect(graph.ownFile(`${folder}/${note.name}.txt`)).toStrictEqual(theirs);
  });

  it("finds a draft whose answer was lost, by its key or its bytes, and never writes it twice", async () => {
    const connection = await connected();
    const outcomes: string[] = [];
    for (const [input, key] of [
      [letter, "run-2:letter"],
      [note, "run-2:note"],
    ] as const) {
      graph.loseWriteAnswer();
      // oxlint-disable-next-line no-await-in-loop -- one write at a time
      outcomes.push(await outcome(draft(connection, input, key)));
      // oxlint-disable-next-line no-await-in-loop -- one write at a time
      await claimedAgo(connection);
      // oxlint-disable-next-line no-await-in-loop -- one write at a time
      outcomes.push(await outcome(draft(connection, input, key)));
    }
    expect(outcomes).toStrictEqual([
      "connect.outcome_unknown",
      "ok",
      "connect.outcome_unknown",
      "ok",
    ]);
    expect({
      writesDone: graph.writesDone(),
      writes: writes().length,
    }).toStrictEqual({ writesDone: 2, writes: 2 });
  });

  it("writes a draft once more when its lookup finds nothing at its name", async () => {
    const connection = await connected();
    graph.failWrite(503);
    const lost = await outcome(draft(connection, letter, "run-3:letter"));
    await claimedAgo(connection);
    const made = await outcome(draft(connection, letter, "run-3:letter"));
    expect({ lost, made, writes: writes().length }).toStrictEqual({
      lost: "connect.outcome_unknown",
      made: "ok",
      writes: 2,
    });
    expect(graph.ownFile(`${folder}/${letter.name}.docx`)).toBeDefined();
  });

  it("leaves a lost draft unknown when another file is at its name, and writes nothing", async () => {
    const connection = await connected();
    for (const [input, path] of [
      [letter, `${folder}/${letter.name}.docx`],
      [note, `${folder}/${note.name}.txt`],
    ] as const) {
      graph.loseWriteAnswer();
      // oxlint-disable-next-line no-await-in-loop -- one write at a time
      await outcome(draft(connection, input, `run-4:${input.format}`));
      // The person replaced it with a file of their own since.
      graph.putOwnFile(path, new TextEncoder().encode("Something else"));
    }
    await claimedAgo(connection);
    const outcomes = await Promise.all(
      [letter, note].map(
        async (input) =>
          await outcome(draft(connection, input, `run-4:${input.format}`))
      )
    );
    expect(outcomes).toStrictEqual([
      "connect.outcome_unknown",
      "connect.outcome_unknown",
    ]);
    expect(writes()).toHaveLength(2);
  });
});
