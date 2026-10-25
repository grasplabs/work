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
const agentMayUse = async (connectionId: string): Promise<void> => {
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
 * A shared mail connection in connect's registry, as a Composio toolkit's,
 * allowing `tools`, to a mail server of its own that answers its next
 * calls as `plan` says (then sends mail), and tells what it did. The
 * chat's agent may use it (`agentMayUse`).
 */
export const mailConnection = async (
  plan: MailAnswer[] = [],
  tools: unknown[] = ["mail.send"]
) => {
  const name = `mail-${crypto.randomUUID()}`;
  const id = `connection-${name}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, status, server_kind, server, tools, created_at, updated_at) VALUES (?, 'mail', 'shared', 'active', 'composio', ?, ?, ?, ?)"
    )
    .bind(id, mailServerUrl(name), JSON.stringify(tools), now, now)
    .run();
  await agentMayUse(id);
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
    /** The queries `mail.search` ran for, in order. */
    searched: async () => {
      const response = await providers().fetch(mailControlUrl(name));
      return z
        .object({ searched: z.array(z.string()) })
        .parse(await response.json()).searched;
    },
  };
};
