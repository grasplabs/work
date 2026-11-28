/**
 * An alert as Grasp's Discord shows it (src/alerts/senders.ts): a card,
 * one embed an alert, read at a glance. Its colour says what happened
 * (red, a failure; green, a recovery; grey, a test), its title what and
 * to what, its fields the organization, release, channel, code and when,
 * and its title and one link lead to the admin's page for it. A test
 * sends sample alerts through this same card (src/alerts/channels.ts).
 *
 * The limits are Discord's (Message resource, Embed Limits): an embed's
 * title 256 characters, description 4096, 25 fields of a 256-character
 * name and a 1024-character value, footer 2048, and up to 10 embeds a
 * message with at most 6000 of those characters between them. A card
 * that breaks one, or can't be built, goes as the plain message instead.
 *
 * Threat model, beside the sender's:
 *
 * - Text from outside formatting, pinging or linking. An organization's
 *   name is staff's and a code can be an upstream service's words: each is
 *   shown as typed, every character Discord's markdown gives a meaning
 *   escaped (`plain`), or inside inline code, where nothing formats
 *   (`code`), and on one line. Nobody can be pinged anyway
 *   (`allowed_mentions`), and embeds never ping.
 * - A long text breaking the post. Each is cut to its limit with an
 *   ellipsis, never inside an escape.
 * - Nothing else reaches the card: the identifiers, code and name a
 *   message had before, a channel, times, and the admin's own link.
 */
import "@tanstack/react-start/server-only";
import { log } from "@grasp-os/shared/log";

import { channelWords } from "../rollout/channel-words.ts";
import type { AlertFacts, AlertOrganization } from "./message.ts";

/** Discord's embed limits (Message resource, Embed Limits). */
const limits = {
  title: 256,
  fieldValue: 1024,
  embeds: 10,
  total: 6000,
} as const;

/** The most characters of a plain message (Execute Webhook's `content`). */
const contentMax = 2000;

/** Red, green and grey, as Discord's own palette has them. */
const colors = { failure: 0xed_42_45, recovery: 0x57_f2_87, test: 0x99_aa_b5 };

/** One field of a card. */
interface DiscordField {
  name: string;
  value: string;
  inline: boolean;
}

/** A card, as Execute Webhook takes one in `embeds`. */
export interface DiscordEmbed {
  title: string;
  description: string;
  url?: string;
  color: number;
  fields: DiscordField[];
  footer: { text: string };
  timestamp: string;
}

/** What Execute Webhook is sent: cards, or the plain message they stand for. */
type DiscordPost =
  | { embeds: DiscordEmbed[]; content?: never }
  | { content: string; embeds?: never };

/**
 * The characters Discord's markdown gives a meaning: emphasis, code,
 * spoilers, quotes, headings and lists, links, mentions, timestamps and
 * emoji, and the colon of `https:` that starts a link.
 */
const markdownCharacters = /[\\*_~`|<>#+\-[\]()@:]/gu;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
// Bidirectional overrides too, which would reorder a line's text.
const breaks = /[\s\p{Cc}\u202A-\u202E\u2066-\u2069]+/gu;

/** `raw` on one line: each run of whitespace, control and direction characters a space. */
const oneLine = (raw: string): string => raw.replaceAll(breaks, " ").trim();

/** `text`'s characters as a reader sees them: an emoji or accented letter is one. */
const charactersOf = (text: string): string[] =>
  Array.from(graphemes.segment(text), ({ segment }) => segment);

/**
 * `tokens` joined, at most `max` characters: cut short with an ellipsis
 * between two tokens when they're longer.
 */
const fit = (tokens: readonly string[], max: number): string => {
  const whole = tokens.join("");
  if (whole.length <= max) {
    return whole;
  }
  let cut = "";
  for (const token of tokens) {
    if (cut.length + token.length > max - 1) {
      break;
    }
    cut += token;
  }
  return `${cut}…`;
};

/**
 * `raw` shown as typed in Discord's markdown, on one line, at most `max`
 * characters: each character with a meaning escaped, and cut short
 * between characters, never inside an escape.
 */
const plain = (raw: string, max: number): string =>
  fit(
    charactersOf(oneLine(raw)).map((character) =>
      character.replaceAll(markdownCharacters, (meaning) => `\\${meaning}`)
    ),
    max
  );

/**
 * `raw` as inline code, which Discord shows as typed: nothing in it
 * formats, mentions or links. A backtick, which would end it, is shown as
 * a modifier grave; at most `max` characters, backticks included.
 */
const code = (raw: string, max: number): string => {
  const characters = charactersOf(oneLine(raw).replaceAll("`", "ˋ"));
  return characters.length === 0 ? "none" : `\`${fit(characters, max - 2)}\``;
};

/** `date` as Discord shows a time relative to now, for each reader: "12 minutes ago". */
const relative = (date: Date): string =>
  `<t:${Math.floor(date.getTime() / 1000)}:R>`;

const units = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
] as const;

/** `ms` in its two largest whole units, such as "3 hours 12 minutes". */
const durationWords = (ms: number): string => {
  const parts: string[] = [];
  let left = Math.max(0, ms);
  for (const [unit, size] of units) {
    const count = Math.floor(left / size);
    left -= count * size;
    if (count > 0 && parts.length < 2) {
      parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    } else if (parts.length > 0) {
      break;
    }
  }
  return parts.length === 0 ? "under a minute" : parts.join(" ");
};

/** A field; one with nothing to say says so, as Discord takes no empty value. */
const field = (name: string, value: string, inline = true): DiscordField => ({
  name,
  value: value === "" ? "none" : value,
  inline,
});

/** The organization's field: its name over its id. */
const organizationField = (
  clientId: string,
  organization: AlertOrganization | null
): DiscordField => {
  const id = code(clientId, limits.fieldValue / 2);
  const name =
    organization === null
      ? null
      : plain(organization.name, limits.fieldValue - id.length - 1);
  return field("Organization", name === null ? id : `${name}\n${id}`);
};

/** The release channel an organization follows, and that it's pinned. */
const channelField = (organization: AlertOrganization): DiscordField => {
  const channel = channelWords[organization.channel];
  return field(
    "Channel",
    organization.pinnedReleaseId === null ? channel : `${channel} (pinned)`
  );
};

/** How long it failed, for a recovery that knows when its failure began. */
const failingFor = (facts: AlertFacts, failedAt?: number): DiscordField[] =>
  failedAt === undefined
    ? []
    : [field("Failing for", durationWords(facts.at.getTime() - failedAt))];

/** What the card says of `facts`: its title, next step and fields. */
const contentOf = (
  facts: AlertFacts
): { what: string; about: string; next: string; fields: DiscordField[] } => {
  const { event, organization } = facts;
  const stage = field("Stage", plain(facts.stage, limits.fieldValue));
  if (event.kind === "rollout_blocked") {
    return {
      what: "Rollouts paused",
      about: "Cloudflare's rate limit",
      next: "No organization starts deploying until the block ends; the runs out wait it out.",
      fields: [
        field("Until", relative(new Date(event.until))),
        field("Since", relative(facts.at)),
        stage,
      ],
    };
  }
  const release = field("Release", plain(event.releaseId, limits.fieldValue));
  if (event.kind === "rollout_halted") {
    const channel = channelWords[event.channel];
    return {
      what: "Rollout halted",
      about: `${channel} ${event.releaseId}`,
      next: `Nothing new starts on ${channel} until staff resume it, or promote another release.`,
      fields: [
        field("Channel", channel),
        release,
        field("Failed", String(event.failed)),
        field("Done", String(event.done)),
        field("Since", relative(facts.at)),
        stage,
      ],
    };
  }
  if (event.kind === "import_failed") {
    return {
      what: "Release didn't import",
      about: event.releaseId,
      next: "The admin tries again by itself, waiting longer each time.",
      fields: [
        release,
        field("Attempt", String(event.attempt)),
        field("Failure code", code(event.code, limits.fieldValue), false),
        field("Since", relative(facts.at)),
        stage,
      ],
    };
  }
  if (event.kind === "imported") {
    return {
      what: "Release imported",
      about: event.releaseId,
      next: "It imported after failing before.",
      fields: [release, ...failingFor(facts, event.failedAt), stage],
    };
  }
  const about = organization?.name ?? event.clientId;
  const where = [
    organizationField(event.clientId, organization),
    release,
    ...(organization === null ? [] : [channelField(organization)]),
  ];
  return event.kind === "deploy_failed"
    ? {
        what: "Deploy failed",
        about,
        next: "Retry it on its Setup once what stopped it is fixed.",
        fields: [
          ...where,
          field("Failure code", code(event.code, limits.fieldValue), false),
          field("Since", relative(facts.at)),
          stage,
        ],
      }
    : {
        what: "Deploy recovered",
        about,
        next: `It runs release ${plain(event.releaseId, limits.title)} now, after the failed deploy.`,
        fields: [...where, ...failingFor(facts, event.failedAt), stage],
      };
};

/** What marks a test, above everything else it says. */
const testLine =
  "**A test, sent by hand from the admin: no organization is affected and nothing failed.**";

/** `link` in a markdown link's parentheses: one of its own ends nothing. */
const linkTarget = (link: string): string =>
  link.replaceAll("(", "%28").replaceAll(")", "%29");

/** `facts` as a card. Throws on a time that isn't one. */
export const embedOf = (facts: AlertFacts): DiscordEmbed => {
  const { what, about, next, fields } = contentOf(facts);
  const title = `${facts.test ? "Test: " : ""}${what}: `;
  const failed =
    facts.event.kind === "import_failed" ||
    facts.event.kind === "deploy_failed" ||
    facts.event.kind === "rollout_halted" ||
    facts.event.kind === "rollout_blocked";
  const lines = [
    ...(facts.test ? [testLine, ""] : []),
    next,
    ...(facts.link === null
      ? []
      : ["", `[Open in admin](${linkTarget(facts.link)})`]),
  ];
  return {
    title: `${title}${plain(about, limits.title - title.length)}`,
    description: lines.join("\n"),
    ...(facts.link === null ? {} : { url: facts.link }),
    color: facts.test ? colors.test : colors[failed ? "failure" : "recovery"],
    fields,
    footer: { text: `Grasp admin · ${facts.stage}` },
    timestamp: facts.at.toISOString(),
  };
};

/** The characters of `embeds` Discord counts toward a message's total. */
const counted = (embeds: readonly DiscordEmbed[]): number =>
  embeds.reduce(
    (sum, embed) =>
      sum +
      embed.title.length +
      embed.description.length +
      embed.footer.text.length +
      embed.fields.reduce(
        (fields, { name, value }) => fields + name.length + value.length,
        0
      ),
    0
  );

/** A message as a plain post, as Discord took alerts before cards: its subject in bold, its text and its link. */
const plainPost = ({
  subject,
  text,
  link,
}: {
  subject: string;
  text: string;
  link: string | null;
}): DiscordPost => {
  const content = [
    `**${plain(subject, limits.title)}**`,
    plain(text, contentMax - limits.title - 512),
    ...(link === null ? [] : [link]),
  ].join("\n");
  return { content: content.slice(0, contentMax) };
};

/**
 * What Discord is sent for `message`: a card for each of its alerts, or,
 * when they break a limit or can't be built, the plain message.
 */
export const discordPostOf = (message: {
  subject: string;
  text: string;
  link: string | null;
  alerts: readonly AlertFacts[];
}): DiscordPost => {
  try {
    const embeds = message.alerts.map(embedOf);
    if (
      embeds.length === 0 ||
      embeds.length > limits.embeds ||
      counted(embeds) > limits.total
    ) {
      throw new RangeError("Beyond Discord's embed limits");
    }
    return { embeds };
  } catch (error) {
    log.warn("alerts.plain_post", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return plainPost(message);
  }
};
