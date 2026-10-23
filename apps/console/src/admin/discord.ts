/**
 * Grasp's Discord bot answering questions (GRA-656's tools, GRA-663): the
 * `/grasp` slash command (src/admin/discord-commands.ts), answered from the
 * admin's read-only tools (`callAdminTool`) over every client as the
 * admin's pages read them. Discord posts each interaction to
 * `POST /discord/interactions`, so the route sits outside Cloudflare Access
 * (src/server.ts); what stands in for Access here is below.
 *
 * Threat model, and how each is closed:
 *
 * - Anyone on the internet posting here. Every request must carry Discord's
 *   Ed25519 signature over its timestamp and body, checked with the
 *   application's public key (`DISCORD_PUBLIC_KEY`) through WebCrypto
 *   before the body is read as anything. Without the key, everything is
 *   refused. A signed request older or newer than five minutes is refused
 *   too, so one caught on its way can't be sent again later.
 * - Someone in Grasp's Discord who isn't staff. Only the Discord user ids
 *   in `DISCORD_STAFF_IDS` get an answer; anyone else gets an ephemeral
 *   refusal, and nothing is read or audited.
 * - Free text reaching a reader. There is no model: each subcommand maps to
 *   tools, and the reply is written here from the tools' structured
 *   answers, with fixed words. It never carries a person's name, what anyone
 *   said in an interview, research text, or a team's or piece of work's
 *   name, the rules the admin's MCP keeps (D5 on GRA-656). Only a
 *   company's own name is shown, as its staff know it, escaped so Discord
 *   renders it as plain text, and no reply pings anyone.
 * - Who sees an answer. Every reply is ephemeral: only the staff member who
 *   asked sees it, never the rest of the channel.
 * - Cost. A question reads every client once, a few at a time within the
 *   grid's deadline (`clientAdmins`), so it is limited per Discord user
 *   (`DISCORD_RATE_LIMIT`); over it, an ephemeral note and no read.
 * - Audit. Each answered question is recorded as `admin.discord.call` by
 *   `discord:<user id>` before anything is read: the subcommand and the
 *   identifiers it was asked about, bounded. Each core records its own
 *   `admin.snapshot.read`, naming the reader `discord-<user id>@<client domain>`.
 *
 * Discord wants an answer within three seconds, and reading every client
 * can take longer: the request is answered at once with a deferred,
 * ephemeral reply, and the answer follows through the interaction's
 * webhook, which needs no bot token.
 *
 * The bot runs on Vercel's Chat SDK (`chat`, its Discord adapter), the same
 * channel layer as Stephen's door into core, so it can grow threads,
 * buttons or another chat app without a second bot framework. The adapter
 * answers Discord's PING, defers each command with the flags given here and
 * sends the reply through the interaction's webhook; this file still checks
 * every request itself before the adapter sees it, and decides every reply.
 */
import { DiscordAdapter } from "@chat-adapter/discord";
import { durableObjectState } from "@grasp-os/chat/state";
import { phaseOf } from "@grasp-os/shared/admin/admin-health";
import type { AdminPhase } from "@grasp-os/shared/admin/admin-health";
import {
  callAdminTool,
  findOrganization,
} from "@grasp-os/shared/admin/admin-tools";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import type { Need } from "@grasp-os/shared/admin/onboarding-admin";
import { fromHex } from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { Chat } from "chat";
import type { AdapterPostableMessage, Logger, SlashCommandEvent } from "chat";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { clientAdmins } from "../clients/admin.ts";
import type { AdminReadOptions } from "../clients/admin.ts";
import { audit, consoleDatabase } from "../db/act.ts";
import { errorCode } from "../deploy/deploy.ts";
import { boundedText } from "../request-body.ts";
import { discordCommandName, discordSubcommands } from "./discord-commands.ts";
import { organizationsOf } from "./views.ts";

/** Where Discord posts interactions. */
export const discordInteractionsPath = "/discord/interactions";

/** Discord's API, where the adapter sends the answer to an interaction: its webhook. */
export const discordApi = "https://discord.com/api/v10";

/** How far a signed request's timestamp may be from the console's clock. */
const maxSkewSeconds = 5 * 60;

/** The most a request's body may be: an interaction is a few kilobytes. */
const maxBodyBytes = 64 * 1024;

/** The longest text a call's audit keeps of what was asked. */
const maxAuditedText = 100;

/** The most a Discord message may hold. */
const maxMessageChars = 2000;

/** Discord's interaction types, and the flag that shows a reply to its asker alone. */
const PING = 1;
const APPLICATION_COMMAND = 2;
const EPHEMERAL = 64;

/** A Discord id (a snowflake). */
const snowflake = z.string().regex(/^\d{1,20}$/u);

const optionSchema = z.object({
  name: z.string(),
  type: z.number(),
  value: z.unknown().optional(),
  get options() {
    return z.array(optionSchema).optional();
  },
});
type Option = z.infer<typeof optionSchema>;

/** An interaction, as far as the bot reads it. */
const interactionSchema = z.object({
  type: z.number(),
  application_id: snowflake,
  token: z.string().regex(/^[\w.-]{1,500}$/u),
  data: z
    .object({ name: z.string(), options: z.array(optionSchema).optional() })
    .optional(),
  member: z.object({ user: z.object({ id: snowflake }) }).optional(),
  user: z.object({ id: snowflake }).optional(),
});
type Interaction = z.infer<typeof interactionSchema>;

const refused = (status: number, text: string): Response =>
  new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const encoder = new TextEncoder();

/**
 * Whether `body` is signed by the Discord application whose public key is
 * `publicKey` (hex), as Discord signs it: Ed25519 over the timestamp
 * header followed by the body, the timestamp within five minutes of `now`.
 */
export const signedByDiscord = async (
  publicKey: string,
  signature: string,
  timestamp: string,
  body: string,
  now: number = Date.now()
): Promise<boolean> => {
  if (
    !/^[\da-f]{64}$/iu.test(publicKey) ||
    !/^[\da-f]{128}$/iu.test(signature) ||
    !/^\d{1,12}$/u.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > maxSkewSeconds
  ) {
    return false;
  }
  const keyBytes = fromHex(publicKey);
  const signatureBytes = fromHex(signature);
  if (keyBytes === undefined || signatureBytes === undefined) {
    return false;
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signatureBytes,
      encoder.encode(`${timestamp}${body}`)
    );
  } catch {
    return false;
  }
};

/** The Discord user ids that are Grasp's staff, from `DISCORD_STAFF_IDS`. */
const staffIds = (env: Env): ReadonlySet<string> =>
  new Set(
    (env.DISCORD_STAFF_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => snowflake.safeParse(id).success)
  );

/** A question, as a subcommand asks it. */
type Question =
  | { ask: "orgs"; phase: string | null }
  | { ask: "org"; organization: string }
  | { ask: "needs" };

const stringOption = (options: readonly Option[], name: string) => {
  const value = options.find((option) => option.name === name)?.value;
  return typeof value === "string" ? value.trim() : null;
};

/** The question the command asks, or null when it isn't one the bot answers. */
const questionOf = (interaction: Interaction): Question | null => {
  const { data } = interaction;
  if (data?.name !== discordCommandName) {
    return null;
  }
  const [sub] = data.options ?? [];
  const options = sub?.options ?? [];
  switch (sub?.name ?? "") {
    case discordSubcommands.orgs: {
      return { ask: "orgs", phase: stringOption(options, "phase") };
    }
    case discordSubcommands.org: {
      const organization = stringOption(options, "name");
      return organization === null || organization === ""
        ? null
        : { ask: "org", organization };
    }
    case discordSubcommands.needs: {
      return { ask: "needs" };
    }
    default: {
      return null;
    }
  }
};

/** What a call's audit keeps of a question: the subcommand, and what it named, bounded. */
const auditedQuestion = (
  question: Question
): Record<string, string | number | boolean> => {
  switch (question.ask) {
    case "orgs": {
      return question.phase === null
        ? {}
        : { phase: question.phase.slice(0, maxAuditedText) };
    }
    case "org": {
      return { organization: question.organization.slice(0, maxAuditedText) };
    }
    case "needs": {
      return {};
    }
    default: {
      return question satisfies never;
    }
  }
};

/** A company's name as plain text in Discord: none of its characters render as markdown or mention anyone. */
const plainText = (text: string): string =>
  text.replaceAll(/[\\*_`~|>#[\]()<@:-]/gu, (character) => `\\${character}`);

const PHASE: Record<AdminPhase, string> = {
  start: "starting",
  agreements: "agreements and sign-in",
  interviews: "interviews",
  ready: "ready for Grasp's go",
  open: "open",
};

/**
 * What needs Grasp, by kind, in fixed words: never the need's own text,
 * which can carry a lead's name, a team's or a piece of work's name, or
 * research text.
 */
const NEED: Record<Need["kind"], string> = {
  paused: "interviews paused by Grasp",
  transcript: "the first conversation to bring in or read",
  ask: "questions left open for the sponsor",
  research: "research not started",
  conflict: "the research disagrees with the company's account",
  agreement: "an agreement not signed",
  lead: "a team lead who hasn't talked yet",
  quiet: "a team gone quiet",
  blocked: "a piece of work that can't be known yet",
  split: "a piece of work to split",
  few: "work with too few people to ask",
  read: "interviews to read",
  go: "ready for Grasp's go",
  short: "interviews over under the threshold",
  contract: "a contract not signed",
  ending: "a contract ending",
  signin: "an app that needs signing in again",
  budget: "more AI than the contract covers",
  overdue: "invoices overdue",
};

const isNeedKind = (kind: unknown): kind is Need["kind"] =>
  typeof kind === "string" && Object.hasOwn(NEED, kind);

const listedSchema = z.object({
  organizations: z.array(
    z.object({ id: z.string(), known: z.number(), needs: z.number() })
  ),
});

const needsSchema = z.object({
  needs: z.array(z.object({ id: z.string(), kind: z.string() })),
});

/** "1 thing", "2 things". */
const many = (count: number, one: string, other: string) =>
  `${count} ${count === 1 ? one : other}`;

/** An organization as a reply names it: its name, as plain text, and its id. */
const named = (view: AdminView) =>
  `**${plainText(view.org.name)}** (\`${view.org.id}\`)`;

/** One organization in a line. */
const orgLine = (
  view: AdminView,
  row: z.infer<typeof listedSchema>["organizations"][number]
) =>
  `- ${named(view)}: ${PHASE[phaseOf(view)]}; ${row.known}% known; ${many(row.needs, "thing needs", "things need")} Grasp`;

/** What needs Grasp at one organization, as fixed words. */
const needLines = (kinds: readonly string[]): string[] =>
  kinds.map(
    (kind) => `  - ${isNeedKind(kind) ? NEED[kind] : "something else"}`
  );

/** Lines, cut to what a Discord message holds, with how many were left out. */
const fit = (head: string, lines: readonly string[]): string => {
  let text = head;
  for (const [index, line] of lines.entries()) {
    const left = lines.length - index;
    const more = `\n… and ${left} more in the admin.`;
    if (text.length + 1 + line.length + more.length > maxMessageChars) {
      return `${text}${more}`;
    }
    text = `${text}\n${line}`;
  }
  return text;
};

/** The day the tools count to: the console's, in UTC. */
const todayNow = () => new Date().toISOString().slice(0, 10);

/** What the bot answers a question with, from the admin's tools over `views`. */
export const answerOf = (
  question: Question,
  views: readonly AdminView[],
  today: string
): string => {
  const byId = new Map(views.map((view) => [view.org.id, view]));
  const listed = (input: Record<string, unknown>) =>
    listedSchema.safeParse(
      callAdminTool("list_organizations", input, views, today).structured
    ).data?.organizations ?? [];
  const needs = () =>
    needsSchema.safeParse(
      callAdminTool("what_needs_grasp", {}, views, today).structured
    ).data?.needs ?? [];
  switch (question.ask) {
    case "orgs": {
      const answer = callAdminTool(
        "list_organizations",
        question.phase === null ? {} : { phase: question.phase },
        views,
        today
      );
      if (answer.failed === true) {
        return "That isn't a phase: start, agreements, interviews, ready or open.";
      }
      const rows =
        listedSchema.safeParse(answer.structured).data?.organizations ?? [];
      const lines = rows.flatMap((row) => {
        const view = byId.get(row.id);
        return view === undefined ? [] : [orgLine(view, row)];
      });
      return lines.length === 0
        ? "No company is there."
        : fit(`${many(lines.length, "company", "companies")}:`, lines);
    }
    case "org": {
      const found = findOrganization(views, question.organization);
      if (typeof found === "string") {
        return "No single company fits that. `/grasp orgs` lists them, with their ids.";
      }
      const row = listed({}).find((each) => each.id === found.org.id);
      const kinds = needs()
        .filter((need) => need.id === found.org.id)
        .map((need) => need.kind);
      if (row === undefined) {
        return "No single company fits that. `/grasp orgs` lists them, with their ids.";
      }
      return fit(
        orgLine(found, row),
        kinds.length === 0 ? ["Nothing needs Grasp there."] : needLines(kinds)
      );
    }
    case "needs": {
      const all = needs();
      if (all.length === 0) {
        return "Nothing needs Grasp anywhere.";
      }
      // By company, in the order its most pressing need comes.
      const byOrg = new Map<string, string[]>();
      for (const need of all) {
        byOrg.set(need.id, [...(byOrg.get(need.id) ?? []), need.kind]);
      }
      const lines = [...byOrg].flatMap(([id, kinds]) => {
        const view = byId.get(id);
        return view === undefined
          ? []
          : [`- ${named(view)}`, ...needLines(kinds)];
      });
      return fit(
        `${many(all.length, "thing needs", "things need")} Grasp:`,
        lines
      );
    }
    default: {
      return question satisfies never;
    }
  }
};

/** What answering takes, apart from the request. */
export interface DiscordOptions {
  /** How every client is read: the grid's limits, unless a test says otherwise. */
  reads?: AdminReadOptions;
  /** The day the tools count to; today, in UTC, unless a test says otherwise. */
  today?: () => string;
}

/**
 * Chat SDK's Discord adapter, sending the bot's words as written and
 * pinging nobody. The bot writes Discord's markdown itself, in fixed words
 * with every name escaped (`plainText`), so a reply is sent as it is: the
 * adapter would turn any `@name` in it into a mention. And the adapter sets
 * no `allowed_mentions`, so this sets them to none, whatever a company's
 * name holds.
 */
class QuietDiscordAdapter extends DiscordAdapter {
  protected override buildMessagePayload(
    message: AdapterPostableMessage,
    options?: { clearContentForCard?: boolean }
  ): ReturnType<DiscordAdapter["buildMessagePayload"]> {
    const built = super.buildMessagePayload(message, options);
    const payload =
      typeof message === "string"
        ? { ...built.payload, content: message }
        : built.payload;
    return {
      ...built,
      payload: { ...payload, allowed_mentions: { parse: [] } },
    };
  }
}

/**
 * Chat SDK's logs stay out of the console's: the adapter logs the
 * signatures it checks at info, and what fails is logged here instead.
 */
const silent = (): void => undefined;
const quiet: Logger = {
  child: () => quiet,
  debug: silent,
  info: silent,
  warn: silent,
  error: silent,
};

/**
 * Answers one staff member's `/grasp` question as the adapter hands it on:
 * each reply goes to the interaction's deferred, ephemeral message.
 */
const answerCommand = async (
  env: Env,
  event: SlashCommandEvent,
  options: DiscordOptions
): Promise<void> => {
  const reply = async (content: string) => {
    await event.channel.post(content);
  };
  const user = event.user.userId;
  if (!staffIds(env).has(user)) {
    await reply("Only Grasp's staff can ask Grasp here.");
    return;
  }
  const interaction = interactionSchema.safeParse(event.raw);
  const question = interaction.success ? questionOf(interaction.data) : null;
  if (question === null) {
    await reply(
      "Ask `/grasp orgs`, `/grasp org name:<company>` or `/grasp needs`."
    );
    return;
  }
  const { success } = await env.DISCORD_RATE_LIMIT.limit({ key: user });
  if (!success) {
    log.warn("admin.discord_limited", { user });
    await reply("Too many questions: wait a minute and ask again.");
    return;
  }
  const domain = env.CLIENT_DOMAIN ?? "";
  if (domain === "") {
    await reply(
      "The console can't read the companies: it has no client domain."
    );
    return;
  }
  // Recorded before anything is read, so a question that fails is still an
  // audited attempt.
  await audit(consoleDatabase(env.DB), `discord:${user}`, {
    action: "admin.discord.call",
    target: question.ask,
    detail: auditedQuestion(question),
  });
  const reader: Staff = { email: `discord-${user}@${domain}`, sub: "" };
  try {
    const views = organizationsOf(
      await clientAdmins(env, reader, options.reads)
    ).flatMap(({ view }) => (view === null ? [] : [view]));
    const today = options.today?.() ?? todayNow();
    await reply(answerOf(question, views, today));
  } catch (error) {
    log.warn("admin.discord_unanswered", { error: errorCode(error) });
    try {
      await reply("The admin couldn't answer that now.");
    } catch {
      // Discord's own failure: nothing more to tell anyone.
    }
  }
};

/**
 * The bot for one interaction Discord signed: Chat SDK's, its state in the
 * console's Durable Objects. Its replies use only the interaction's
 * webhook, so it has no bot token; were it ever to call Discord's API as
 * the bot, that call fails here instead of going out unauthenticated.
 */
const discordBot = (
  env: Env,
  applicationId: string,
  options: DiscordOptions
) => {
  const states =
    env.DURABLE_OBJECT_JURISDICTION === "none"
      ? env.CHAT_STATE
      : env.CHAT_STATE.jurisdiction("eu");
  const bot = new Chat({
    userName: "grasp",
    logger: quiet,
    state: durableObjectState(states),
    adapters: {
      discord: new QuietDiscordAdapter({
        applicationId,
        botToken: () => {
          throw new Error("The console's Discord bot has no bot token.");
        },
        // The route checked the request already; the adapter checks it
        // again, the same way, before anything reaches a handler.
        webhookVerifier: async (request, body) =>
          await signedByDiscord(
            env.DISCORD_PUBLIC_KEY ?? "",
            request.headers.get("x-signature-ed25519") ?? "",
            request.headers.get("x-signature-timestamp") ?? "",
            body
          ),
        // Every reply, refusals included, is the asker's alone.
        interactionFlags: () => EPHEMERAL,
        logger: quiet,
      }),
    },
  });
  bot.onSlashCommand(async (event) => {
    try {
      await answerCommand(env, event, options);
    } catch (error) {
      // What escapes (the audit's write, the rate limiter) would reach only
      // the Chat SDK's logger, which is quiet: the console's log has it.
      log.warn("admin.discord_failed", { error: errorCode(error) });
      throw error;
    }
  });
  return bot;
};

/**
 * Answers one request Discord posts to the console: a PING with a PONG, a
 * `/grasp` question with a deferred, ephemeral reply whose answer, or
 * refusal, `waitUntil` sends. Anything not signed by the application is 401.
 */
export const discordInteraction = async (
  request: Request,
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  options: DiscordOptions = {}
): Promise<Response> => {
  if (request.method !== "POST") {
    return refused(405, "Method not allowed.");
  }
  const body = await boundedText(request, maxBodyBytes);
  if (body === undefined) {
    return refused(413, "Too large.");
  }
  const signed = await signedByDiscord(
    env.DISCORD_PUBLIC_KEY ?? "",
    request.headers.get("x-signature-ed25519") ?? "",
    request.headers.get("x-signature-timestamp") ?? "",
    body
  );
  if (!signed) {
    return refused(401, "Invalid request signature.");
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return refused(400, "Not JSON.");
  }
  const read = interactionSchema.safeParse(parsed);
  if (!read.success) {
    return refused(400, "Not an interaction.");
  }
  if (read.data.type !== PING && read.data.type !== APPLICATION_COMMAND) {
    return refused(400, "Not an interaction the bot answers.");
  }
  const bot = discordBot(env, read.data.application_id, options);
  return await bot.webhooks.discord(
    new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body,
    }),
    { waitUntil }
  );
};
