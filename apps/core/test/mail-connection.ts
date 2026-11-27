/**
 * Mail connections in connect's registry for core's tests: each a Composio
 * toolkit's, to a mail server of its own (test/mail-server.ts). Its admin
 * allowed `mail.send`, a side effect, and may allow `mail.search` too.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";

import { mailControlUrl, mailServerUrl } from "./mail-server.ts";
import type { MailAnswer } from "./mail-server.ts";
import { connectDb, testBinding } from "./test-env.ts";

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The outside systems connect reaches (test/connect-providers.ts). */
const providers = (): Fetcher => {
  const fetcher = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(fetcher)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return fetcher;
};

const mailServerStateSchema = z.object({
  calls: z.number(),
  sent: z.array(z.object({ to: z.string(), subject: z.string() })),
});

/** `mail.send`, and `mail.search` marked as a read, as an admin allows them. */
export const mailWithSearch = [
  "mail.send",
  { name: "mail.search", read: true },
];

/**
 * The mail tools by the names an App's connector resource declares,
 * `MAIL_SEND`, and `MAIL_SEARCH` marked as a read, beside `mail.send` and
 * `mail.search` for the workflows' own calls.
 */
export const mailForApps = [
  ...mailWithSearch,
  "MAIL_SEND",
  { name: "MAIL_SEARCH", read: true },
];

/**
 * A company that lets the chat's agent work in the mail app `connectionId`
 * (GRA-725): an admin pointed it at the app for everyone, and turned on
 * changing the company's things and reaching others. The classes' defaults
 * are tested in tool-classes.test.ts and app-pointers.test.ts.
 */
export const agentMayUse = async (connectionId: string): Promise<void> => {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO app_pointers (connection_id, resources, who, teams, changed_by, changed_at) VALUES (?, '[]', 'everyone', '[]', 'test-admin', ?)"
    ).bind(connectionId, now),
    ...["change-company", "reach-others"].map((toolClass) =>
      env.DB.prepare(
        "INSERT OR REPLACE INTO tool_class_settings (tool_class, who, teams, changed_by, changed_at) VALUES (?, 'everyone', '[]', 'test-admin', ?)"
      ).bind(toolClass, now)
    ),
  ]);
};

/**
 * A shared Microsoft 365 connection in connect's registry, as connect's
 * native connector serves it, which the chat's agent may use
 * (`agentMayUse`): its tools are described by the connector's manifest.
 */
export const nativeMailConnection = async (): Promise<{ id: string }> => {
  const id = `connection-${crypto.randomUUID()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'microsoft', 'shared', NULL, 'active', 'native', 'microsoft-365', ?, ?)"
    )
    .bind(id, now, now)
    .run();
  await agentMayUse(id);
  return { id };
};

/**
 * A connection to a connector made from an MCP server's URL, in connect's
 * registry, shared unless `owner` is given, whose server listed `tools`
 * (each with its description and input) a moment ago, so connect reads
 * its kept list, which the chat's agent may use (`agentMayUse`).
 */
export const connectorConnection = async (
  tools: readonly { name: string; description: string; inputSchema: unknown }[],
  owner?: string
): Promise<{ id: string }> => {
  const id = `connection-${crypto.randomUUID()}`;
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  await connectDb().batch([
    connectDb()
      .prepare(
        "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tool_list_read_at, tool_list_fresh_until, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 'connector', 'https://mcp.tracker.test/mcp', ?, ?, ?, ?)"
      )
      .bind(
        id,
        `connector-${crypto.randomUUID()}`,
        owner === undefined ? "shared" : "personal",
        owner ?? null,
        now,
        now + hour,
        now,
        now
      ),
    ...tools.map(({ name, description, inputSchema }) =>
      connectDb()
        .prepare(
          "INSERT INTO connection_tools (connection_id, name, description, input_schema, output_schema, annotations) VALUES (?, ?, ?, ?, NULL, '{}')"
        )
        .bind(id, name, description, JSON.stringify(inputSchema))
    ),
  ]);
  await agentMayUse(id);
  return { id };
};

/**
 * A mail connection in connect's registry, shared unless `owner` is
 * given, as a Composio toolkit's,
 * allowing `tools`, to a mail server of its own that answers its next
 * calls as `plan` says (then sends mail), and tells what it did. The
 * chat's agent may use it (`agentMayUse`). A shared one is for nobody,
 * as one no admin chose an audience for (connection-audiences.ts), unless
 * `audience` is everyone in the company.
 */
export const mailConnection = async (
  plan: MailAnswer[] = [],
  tools: unknown[] = ["mail.send"],
  {
    provider = "mail",
    owner,
    audience = "nobody",
  }: {
    /** Its toolkit, whose read-only tools test/composio-api.ts lists. */
    provider?: string;
    /** The person whose own connection it is: none for a shared one. */
    owner?: string;
    /** A shared one's audience: nobody until a test chooses, or everyone. */
    audience?: "everyone" | "nobody";
  } = {}
) => {
  const name = `mail-${crypto.randomUUID()}`;
  const id = `connection-${name}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tools, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 'composio', ?, ?, ?, ?)"
    )
    .bind(
      id,
      provider,
      owner === undefined ? "shared" : "personal",
      owner ?? null,
      mailServerUrl(name),
      JSON.stringify(tools),
      now,
      now
    )
    .run();
  await agentMayUse(id);
  if (owner === undefined && audience === "everyone") {
    await env.DB.prepare(
      "INSERT INTO connection_brain_audiences (connection_id, team_id, changed_by, changed_at) VALUES (?, NULL, 'test-admin', ?)"
    )
      .bind(id, now)
      .run();
  }
  await providers().fetch(mailControlUrl(name), {
    method: "POST",
    body: JSON.stringify({ plan }),
  });
  return {
    id,
    /** Whether the server holds a `slow` call now. */
    holding: async () => {
      const response = await providers().fetch(mailControlUrl(name));
      return z.object({ holding: z.boolean() }).parse(await response.json())
        .holding;
    },
    /** Lets a held `slow` call go through. */
    release: async () => {
      await providers().fetch(mailControlUrl(name), {
        method: "POST",
        body: JSON.stringify({ release: true }),
      });
    },
    /** What the mail server did: calls that reached `mail.send`, mail sent. */
    did: async () => {
      const response = await providers().fetch(mailControlUrl(name));
      return mailServerStateSchema.parse(await response.json());
    },
    /** Lists `tools` (MCP tool definitions) from now on. */
    serves: async (listed: unknown[]) => {
      await providers().fetch(mailControlUrl(name), {
        method: "POST",
        body: JSON.stringify({ list: listed }),
      });
    },
    /** Answers each tool with its MCP tool result from now on, these alone. */
    answers: async (results: Record<string, unknown>) => {
      await providers().fetch(mailControlUrl(name), {
        method: "POST",
        body: JSON.stringify({ answers: results }),
      });
    },
    /** Answers `tool` with `result` (an MCP tool result) from now on. */
    answer: async (tool: string, result: unknown) => {
      await providers().fetch(mailControlUrl(name), {
        method: "POST",
        body: JSON.stringify({ answers: { [tool]: result } }),
      });
    },
    /** The queries `mail.search` ran for, in order. */
    searched: async () => {
      const response = await providers().fetch(mailControlUrl(name));
      return z
        .object({ searched: z.array(z.string()) })
        .parse(await response.json()).searched;
    },
  };
};
