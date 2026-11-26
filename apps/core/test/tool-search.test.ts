import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  chatOf,
  codeResults,
  codeStep,
  model,
  says,
  withoutMarking,
} from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  connectorConnection,
  mailConnection,
  mailWithSearch,
  nativeMailConnection,
} from "./mail-connection.ts";
import { signedInApi } from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Tool search in a chat's code (`env.connections.search` and `describe`):
// the chat's agent finding the one tool a task needs among thousands, then
// calling it as any other. The ways it can fail, first: a tool the person
// can't use is shown, or counted in the ranking's statistics, so what they
// can't see changes what they are shown; a tool of a connection the chat
// may only ask for looks callable, or is called; the tool found isn't the
// one that runs.

const idp = mockIdp();

/** Thousands of tools listed and ranked, on a slow CI machine. */
const setUpTime = { timeout: 120_000 };

/** A tool of the fake Composio's toolkit `bulk`, each a read (connect's test/fixtures/composio-classes.ts). */
const bulkTool = (index: number): string => `BULK_TOOL_${index}`;

/** Most tools an admin may allow on one Composio connection. */
const toolsPerConnection = 1000;

/**
 * A `bulk` connection, `owner`'s own or else shared, allowing `tools` as
 * reads, whose server takes an invoice for each. A Composio connection's
 * tools are searched by their names alone, so the tests find them by name.
 */
const bulkConnection = async (tools: readonly string[], owner?: string) => {
  const connection = await mailConnection(
    [],
    tools.map((name) => ({ name, read: true })),
    { provider: "bulk", ...(owner === undefined ? {} : { owner }) }
  );
  await connection.serves(
    tools.map((name) => ({
      name,
      inputSchema: {
        type: "object",
        properties: { invoice: { type: "string" } },
        required: ["invoice"],
      },
    }))
  );
  return connection;
};

/** What a code step returned, as the model read it inside any marking. */
const returned = (text: string | undefined): unknown =>
  JSON.parse(withoutMarking(text ?? "").replace(/^Returned:\n/u, ""));

describe("a chat's tool search", setUpTime, () => {
  it("finds the one tool a task needs among thousands, and calls it by its real name", async () => {
    const person = await signedInApi(idp, "user");
    const needle = "BULK_FIND_SHIPMENT";
    const connections = await Promise.all(
      [0, 1, 2].map(
        async (part) =>
          await bulkConnection(
            Array.from({ length: toolsPerConnection }, (_, offset) => {
              const index = part * toolsPerConnection + offset;
              return index === 1500 ? needle : bulkTool(index);
            }),
            person.userId
          )
      )
    );
    const [, holder] = connections;
    await holder?.answer(needle, {
      content: [{ type: "text", text: '{"shipment":"SHP-7"}' }],
      structuredContent: { shipment: "SHP-7" },
    });
    const chat = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => {
          const [found] = await env.connections.search({ queries: ["find a lost shipment"] });
          const [best] = found.matches;
          const { output } = await env.connections.call(best.connection, best.action, { invoice: "INV-7" });
          return { best, matches: found.matches.length, output };
        };`
      ),
      says("Found it.")
    );

    await chat.ask("Find the lost shipment for invoice INV-7.");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      best: {
        connection: holder?.id,
        action: needle,
        summary: "",
        class: "read-company",
        input: "unknown",
      },
      matches: 1,
      output: { shipment: "SHP-7" },
    });
  });

  it("describes a tool as its connector's manifest does: what it does, and its input's and output's types", async () => {
    const admin = await signedInApi(idp, "admin");
    const outlook = await nativeMailConnection();
    const chat = await chatOf(
      admin.userId,
      codeStep(
        `export default async (self, env) => {
          const [found] = await env.connections.search({ queries: ["send mail"] });
          const send = found.matches.find(({ action }) => action === "mail.send");
          const declared = await env.connections.describe("OUTLOOK", ["mail.send"]);
          return { send, declared: declared.split("\\n") };
        };`
      ),
      says("I can send it.")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: outlook.id },
      actions: ["mail.send"],
      binding: "OUTLOOK",
    });

    await chat.ask("Send Ben the invoice.");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const { send, declared } = z
      .object({
        send: z.object({
          connection: z.string(),
          summary: z.string(),
          input: z.string(),
        }),
        declared: z.array(z.string()),
      })
      .parse(returned(result?.text));
    expect({
      connection: send.connection,
      summarised: send.summary !== "",
      typed: send.input.startsWith("{ "),
      called: declared.some((line) =>
        line.startsWith('call(name: "OUTLOOK", action: "mail.send", input: {')
      ),
      answered: declared.some((line) => line.includes("| null; pending:")),
    }).toStrictEqual({
      connection: "OUTLOOK",
      summarised: true,
      typed: true,
      called: true,
      answered: true,
    });
  });

  it("finds and describes a connector's tools as its server lists them", async () => {
    const admin = await signedInApi(idp, "admin");
    const tracker = await connectorConnection([
      {
        name: "list_issues",
        description: "Lists a team's issues. Filters by state.",
        inputSchema: {
          type: "object",
          properties: {
            team: { type: "string", description: "The team's key." },
          },
          required: ["team"],
        },
      },
      {
        name: "save_comment",
        description: "Comments on an issue.",
        inputSchema: {
          type: "object",
          properties: { issue: { type: "string" }, body: { type: "string" } },
        },
      },
    ]);
    const chat = await chatOf(
      admin.userId,
      codeStep(
        `export default async (self, env) => {
          const [found] = await env.connections.search({ queries: ["list a team's issues"], connection: "TRACKER" });
          const declared = await env.connections.describe("TRACKER", ["list_issues"]);
          return { best: found.matches[0], declared: declared.split("\\n") };
        };`
      ),
      says("I can list them.")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: tracker.id },
      actions: ["list_issues", "save_comment"],
      binding: "TRACKER",
    });

    await chat.ask("Which issues does the team have?");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      best: {
        connection: "TRACKER",
        action: "list_issues",
        summary: "Lists a team's issues.",
        class: "read-company",
        input: "{ team: string }",
      },
      declared: [
        "/**",
        " * Lists a team's issues. Filters by state.",
        " *",
        " * Class: read-company.",
        " */",
        'call(name: "TRACKER", action: "list_issues", input: {',
        "  /** The team's key. */",
        "  team: string;",
        "}): Promise<{ output: unknown | null; pending: { id: string } | null }>;",
      ],
    });
  });

  it("finds a granted connector's tools as connect keeps them while its server can't answer, and describes none of them", async () => {
    const admin = await signedInApi(idp, "admin");
    const tracker = await connectorConnection([
      {
        name: "list_issues",
        description: "Lists a team's issues.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    // Its list due again, at a server nobody answers for.
    await connectDb()
      .prepare("UPDATE connections SET tool_list_fresh_until = 0 WHERE id = ?")
      .bind(tracker.id)
      .run();
    const chat = await chatOf(
      admin.userId,
      codeStep(
        `export default async (self, env) => {
          const [found] = await env.connections.search({ queries: ["list a team's issues"], connection: "TRACKER" });
          const described = await env.connections.describe("TRACKER", ["list_issues"]).then(() => "described", () => "failed");
          return { best: found.matches[0]?.action ?? null, described };
        };`
      ),
      says("Its server is down.")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: tracker.id },
      actions: ["list_issues"],
      binding: "TRACKER",
    });

    await chat.ask("Which issues does the team have?");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      best: "list_issues",
      described: "failed",
    });
  });

  it("shows and counts only a connector's tools whose class is on for the person", async () => {
    const admin = await signedInApi(idp, "admin");
    const tracker = await connectorConnection([
      {
        name: "list_issues",
        description: "Lists a team's issues.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "save_comment",
        description: "Comments on an issue.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const chat = await chatOf(
      admin.userId,
      codeStep(
        `export default async (self, env) => {
          const [found] = await env.connections.search({ queries: ["comment on an issue"], connection: "TRACKER" });
          return {
            listed: (await env.connections.list()).find(({ name }) => name === "TRACKER")?.tools,
            found: [...found.matches, ...found.related].map(({ action }) => action),
            declared: await env.connections.describe("TRACKER", ["save_comment"]),
          };
        };`
      ),
      says("I can only list them.")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: tracker.id },
      actions: ["list_issues", "save_comment"],
      binding: "TRACKER",
    });
    await admin.api.connections.setToolClass("change-company", {
      who: "nobody",
    });

    await chat.ask("Comment on the issue.");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      listed: { "read-company": 1 },
      found: ["list_issues"],
      declared:
        '// "TRACKER" has no action "save_comment" this chat may call or ask for.',
    });
  });

  it("ranks by the statistics of the tools the person may use alone, and shows no other", async () => {
    const [person, other] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    // Among the person's own tools \`quokka\` is rarer than \`wombat\`, so
    // the quokka tool ranks first. Someone else's connection holds twenty
    // more quokka tools: counted, they would make \`quokka\` the common
    // word, and a wombat tool would rank first.
    const own = await bulkConnection(
      ["BULK_QUOKKA_READ_0", "BULK_WOMBAT_READ_0", "BULK_WOMBAT_READ_1"],
      person.userId
    );
    await bulkConnection(
      Array.from(
        { length: 20 },
        (_, offset) => `BULK_QUOKKA_READ_${offset + 1}`
      ),
      other.userId
    );
    const chat = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => {
          const [found] = await env.connections.search({ queries: ["quokka wombat"] });
          return [...found.matches, ...found.related].map(({ connection, action }) => ({ connection, action }));
        };`
      ),
      says("Found them.")
    );

    await chat.ask("Which tools read quokkas and wombats?");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const found = z
      .array(z.object({ connection: z.string(), action: z.string() }))
      .parse(returned(result?.text));
    expect({ first: found[0], all: found.length }).toStrictEqual({
      first: { connection: own.id, action: "BULK_QUOKKA_READ_0" },
      all: 3,
    });
  });

  it("marks a tool of a connection the chat may only ask for, calls nothing of it, and shows none in a turn nobody started", async () => {
    const person = await signedInApi(idp, "user");
    const shared = await bulkConnection([
      "BULK_LEDGER_EXPORT",
      ...Array.from({ length: 6 }, (_, offset) => `BULK_LEDGER_READ_${offset}`),
    ]);
    const woken = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => (await env.connections.search({ queries: ["export the ledger"] }))[0].matches;`
      ),
      says("Nothing to export with.")
    );
    await woken.stub.askUnattended(woken.chat.id, {
      text: "Export the ledger.",
      model,
    });
    const chat = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => {
          const [found] = await env.connections.search({ queries: ["export the ledger"] });
          const [match] = found.matches;
          const declared = await env.connections.describe(match.connection, [match.action]);
          let called;
          try {
            await env.connections.call(match.connection, match.action, { invoice: "INV-7" });
            called = "called";
          } catch (error) {
            called = error.code ?? error.message;
          }
          return {
            match,
            all: [...found.matches, ...found.related].map(({ ask }) => ask),
            declared: declared.split("\\n").filter((line) => line.includes("request") || line.startsWith("call(")),
            called,
          };
        };`
      ),
      says("You need to ask for it.")
    );

    await chat.ask("Export the ledger.");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      match: {
        connection: shared.id,
        action: "BULK_LEDGER_EXPORT",
        summary: "",
        class: "read-company",
        input: "unknown",
        ask: true,
      },
      all: Array.from({ length: 7 }, () => true),
      // Granted, it is called by the binding asked for, never by this ID.
      declared: [
        ` * This chat can't call it yet: ask for connection ${JSON.stringify(shared.id)} with \`request\` first, then call it by the binding you asked for.`,
        'call(name: string, action: "BULK_LEDGER_EXPORT", input: unknown): Promise<{ output: unknown | null; pending: { id: string } | null }>;',
      ],
      called: "connect.connection_not_found",
    });
    // Such a turn can't ask for a connection, so it is shown none to ask for.
    const [unattended] = await codeResults(woken.stub, woken.chat.id);
    expect(returned(unattended?.text)).toStrictEqual([]);
  });

  it("offers a connector's tools to ask for as connect keeps its server's list, and lets the chat ask for one", async () => {
    const person = await signedInApi(idp, "user");
    const tracker = await connectorConnection([
      {
        name: "list_issues",
        description: "Lists a team's issues.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "save_comment",
        description: "Comments on an issue.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const chat = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => {
          const offered = (await env.connections.available()).find(({ connectionId }) => connectionId === ${JSON.stringify(tracker.id)});
          const [found] = await env.connections.search({ queries: ["list a team's issues"] });
          const asked = await env.connections.request({ connectionId: ${JSON.stringify(tracker.id)}, actions: ["list_issues"], binding: "TRACKER", reason: "To list the issues." }).then(({ binding }) => binding, (error) => error.message);
          const [best] = found.matches;
          return { best: { action: best.action, ask: best.ask }, offered: offered?.actions.toSorted(), asked };
        };`
      ),
      says("I asked for it.")
    );

    await chat.ask("Which issues does the team have?");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      best: { action: "list_issues", ask: true },
      offered: ["list_issues", "save_comment"],
      asked: "TRACKER",
    });
  });

  it("finds only the tools that read, or only those that change something, when asked", async () => {
    const [person, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const mail = await mailConnection([], mailWithSearch);
    const chat = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => {
          const actions = async (kind) => {
            const [found] = await env.connections.search({ queries: ["mail"], connection: "MAIL", kind });
            return [...found.matches, ...found.related].map(({ action }) => action).toSorted();
          };
          return { all: await actions(), read: await actions("read"), change: await actions("change") };
        };`
      ),
      says("Found them.")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send", "mail.search"],
      binding: "MAIL",
    });

    await chat.ask("Which mail tools do you have?");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      all: ["mail.search", "mail.send"],
      read: ["mail.search"],
      change: ["mail.send"],
    });
  });

  it("shows and counts only the tools whose class is on for the person", async () => {
    const [person, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const [mail, outlook] = await Promise.all([
      mailConnection([], mailWithSearch),
      nativeMailConnection(),
    ]);
    const chat = await chatOf(
      person.userId,
      codeStep(
        `export default async (self, env) => {
          const listed = (await env.connections.list()).filter(({ name }) => name === "MAIL");
          const [found] = await env.connections.search({ queries: ["send mail", "search mail"] });
          const declared = await env.connections.describe("MAIL", ["mail.send", "mail.search"]);
          const native = await env.connections.describe("OUTLOOK", ["mail.send"]);
          return {
            native,
            listed,
            found: (await env.connections.search({ queries: ["send mail"], connection: "MAIL" }))[0].matches.map(({ action }) => action),
            sends: [...found.matches, ...found.related].filter(({ action }) => action === "mail.send").length,
            declared: declared.split("\\n\\n").map((part) => part.split("\\n")[0]),
          };
        };`
      ),
      says("I can only search.")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send", "mail.search"],
      binding: "MAIL",
    });
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: outlook.id },
      actions: ["mail.send"],
      binding: "OUTLOOK",
    });
    // Reaching others is off for everyone: sending mail is too.
    await admin.api.connections.setToolClass("reach-others", { who: "nobody" });

    await chat.ask("Send Ben the invoice.");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      native:
        '// "OUTLOOK" has no action "mail.send" this chat may call or ask for.',
      listed: [
        {
          name: "MAIL",
          account: null,
          resource: null,
          tools: { "read-company": 1 },
        },
      ],
      found: ["mail.search"],
      sends: 0,
      declared: [
        '// "MAIL" has no action "mail.send" this chat may call or ask for.',
        "/**",
      ],
    });
  });
});
