import { describe, expect, it, vi } from "vite-plus/test";

import type { AlertEvent } from "../src/alerts/alert.ts";
import { discordPostOf, embedOf } from "../src/alerts/discord.ts";
import type { DiscordEmbed } from "../src/alerts/discord.ts";
import type { AlertFacts, AlertOrganization } from "../src/alerts/message.ts";

const red = 0xed_42_45;
const green = 0x57_f2_87;
const grey = 0x99_aa_b5;

const failedAt = new Date("2026-11-28T09:00:00.000Z");
const recoveredAt = new Date("2026-11-28T12:12:00.000Z");
const link = "https://admin.grasp.test/organizations/acme/setup";
const acme: AlertOrganization = {
  name: "Acme",
  channel: "beta",
  pinnedReleaseId: null,
};

/** An alert of `event`, as a delivery lays it out: Acme's, on staging. */
const factsOf = (
  event: AlertEvent,
  given: Partial<AlertFacts> = {}
): AlertFacts => ({
  event,
  organization: "clientId" in event ? acme : null,
  at: failedAt,
  link,
  stage: "staging",
  test: false,
  ...given,
});

const deployFailed: AlertEvent = {
  kind: "deploy_failed",
  clientId: "acme",
  releaseId: "26.11.7",
  code: "d1_migration_failed",
};

/** A card's fields by name. */
const fieldsOf = (embed: DiscordEmbed) =>
  Object.fromEntries(
    embed.fields.map(({ name, value, inline }) => [name, { value, inline }])
  );

/** `text` as Discord shows it: each escape its character. */
const shown = (text: string) =>
  text.replaceAll(/\\(?<character>.)/gu, "$<character>");

/** Whether `text` has a character Discord's markdown reads that isn't escaped. */
const unescaped = (text: string) =>
  /[*_~`|<>#+\-[\]()@:]/u.test(text.replaceAll(/\\./gu, ""));

/** `post`'s cards; fails the test when it went as a plain message. */
const embedsOf = (post: ReturnType<typeof discordPostOf>) => {
  if (post.embeds === undefined) {
    throw new Error(`expected cards, got ${post.content}`);
  }
  return post.embeds;
};

/** What a plain message is built from, around `facts`. */
const messageWith = (alerts: AlertFacts[]) => ({
  subject: "Acme: deploy of 26.11.7 failed",
  text: "The deploy of release 26.11.7 to Acme (acme) failed (d1_migration_failed).",
  link,
  alerts,
});

/** `run`, with the plain post's warning kept out of the test output. */
const quietly = <T>(run: () => T): T => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {
    // Logged; the tests read the post.
  });
  try {
    return run();
  } finally {
    warnings.mockRestore();
  }
};

describe("the Discord alert card", () => {
  it("lays a failed deploy out in red: what and to what, the organization, release, channel, code, since when, the stage and its Setup", () => {
    const embed = embedOf(factsOf(deployFailed));

    expect(embed).toStrictEqual({
      title: "Deploy failed: Acme",
      description: `Retry it on its Setup once what stopped it is fixed.\n\n[Open in admin](${link})`,
      url: link,
      color: red,
      fields: [
        { name: "Organization", value: "Acme\n`acme`", inline: true },
        { name: "Release", value: "26.11.7", inline: true },
        { name: "Channel", value: "Beta", inline: true },
        {
          name: "Failure code",
          value: "`d1_migration_failed`",
          inline: false,
        },
        {
          name: "Since",
          value: `<t:${failedAt.getTime() / 1000}:R>`,
          inline: true,
        },
        { name: "Stage", value: "staging", inline: true },
      ],
      footer: { text: "Grasp admin · staging" },
      timestamp: "2026-11-28T09:00:00.000Z",
    });
  });

  it("lays a recovery out in green, with how long it was failing and no code", () => {
    const embed = embedOf(
      factsOf(
        {
          kind: "deployed",
          clientId: "acme",
          releaseId: "26.11.8",
          failedAt: failedAt.getTime(),
        },
        {
          at: recoveredAt,
          organization: { ...acme, pinnedReleaseId: "26.11.8" },
        }
      )
    );

    expect({
      title: embed.title,
      color: embed.color,
      fields: fieldsOf(embed),
      timestamp: embed.timestamp,
    }).toStrictEqual({
      title: "Deploy recovered: Acme",
      color: green,
      fields: {
        Organization: { value: "Acme\n`acme`", inline: true },
        Release: { value: "26.11.8", inline: true },
        Channel: { value: "Beta (pinned)", inline: true },
        "Failing for": { value: "3 hours 12 minutes", inline: true },
        Stage: { value: "staging", inline: true },
      },
      timestamp: "2026-11-28T12:12:00.000Z",
    });
  });

  it("titles a release's failure and import by the release, and names the organization by its id when the admin doesn't hold it", () => {
    const failed = embedOf(
      factsOf({
        kind: "import_failed",
        releaseId: "26.11.7",
        code: "manifest_mismatch",
        attempt: 3,
      })
    );
    const imported = embedOf(
      factsOf(
        {
          kind: "imported",
          releaseId: "26.11.7",
          failedAt: failedAt.getTime() - 90_000,
        },
        { link: null }
      )
    );
    const unknown = embedOf(factsOf(deployFailed, { organization: null }));

    expect({
      failed: [failed.title, failed.color, Object.keys(fieldsOf(failed))],
      imported: [
        imported.title,
        imported.color,
        fieldsOf(imported)["Failing for"]?.value,
        imported.url,
        imported.description,
      ],
      unknown: [unknown.title, fieldsOf(unknown).Organization?.value],
    }).toStrictEqual({
      failed: [
        "Release didn't import: 26.11.7",
        red,
        ["Release", "Attempt", "Failure code", "Since", "Stage"],
      ],
      imported: [
        "Release imported: 26.11.7",
        green,
        "1 minute",
        undefined,
        "It imported after failing before.",
      ],
      unknown: ["Deploy failed: acme", "`acme`"],
    });
  });

  it("says a recovery failed for under a minute when its failure seems later, as a clock that drifted has it", () => {
    const embed = embedOf(
      factsOf({
        kind: "imported",
        releaseId: "26.11.7",
        failedAt: failedAt.getTime() + 60_000,
      })
    );

    expect(fieldsOf(embed)["Failing for"]?.value).toBe("under a minute");
  });

  it("marks a test three ways: its title, grey, and its first line", () => {
    const embed = embedOf(factsOf(deployFailed, { test: true }));

    expect({
      title: embed.title,
      color: embed.color,
      first: embed.description.split("\n")[0],
    }).toStrictEqual({
      title: "Test: Deploy failed: Acme",
      color: grey,
      first:
        "**A test, sent by hand from the admin: no organization is affected and nothing failed.**",
    });
  });

  it("shows an organization's name as typed, on one line: nothing in it formats, pings or links", () => {
    const hostile = [
      "@everyone",
      "@here",
      "**bold** __under__ ~~gone~~ ||spoiler||",
      "[x](http://evil.test)",
      "https://evil.test/path",
      "<@123456789> <#987654321> <t:0:R> <:emoji:1>",
      "`code` ```block```",
      "# heading",
      "> quote",
      "- list",
      "back\\slash",
      "two\nlines\r\nand\ttabs",
      "\u202Ereversed\u202C order",
    ];
    const cards = hostile.map((name) => {
      const embed = embedOf(
        factsOf(deployFailed, { organization: { ...acme, name } })
      );
      const [shownName] = (fieldsOf(embed).Organization?.value ?? "").split(
        "\n"
      );
      return {
        title: embed.title.slice("Deploy failed: ".length),
        name: shownName ?? "",
      };
    });

    expect(
      cards.map(({ title, name }) => ({
        title: [shown(title), unescaped(title)],
        name: [shown(name), unescaped(name)],
      }))
    ).toStrictEqual(
      hostile.map((name) => {
        const line = name.replaceAll(/[\s\u202A-\u202E]+/gu, " ").trim();
        return { title: [line, false], name: [line, false] };
      })
    );
    expect(cards[0]?.name).toBe("\\@everyone");
    expect(cards[3]?.name).toBe("\\[x\\]\\(http\\://evil.test\\)");
  });

  it("shows a code as inline code on one line, a backtick in it unable to end it", () => {
    const embed = embedOf(
      factsOf({
        ...deployFailed,
        code: "`@everyone` <@1> **x**\nmore",
      })
    );

    expect(fieldsOf(embed)["Failure code"]?.value).toBe(
      "`ˋ@everyoneˋ <@1> **x** more`"
    );
  });

  it("cuts a title and a field at Discord's limits, never inside an escape", () => {
    const long = embedOf(
      factsOf(deployFailed, {
        organization: { ...acme, name: "a".repeat(2000) },
      })
    );
    const escaped = embedOf(
      factsOf(
        { ...deployFailed, code: "c".repeat(2000) },
        { organization: { ...acme, name: "*".repeat(2000) }, test: true }
      )
    );
    const organization = fieldsOf(escaped).Organization?.value ?? "";
    const [name] = organization.split("\n");

    expect({
      title: [long.title.length, long.title.endsWith("a…")],
      field: [
        (fieldsOf(long).Organization?.value ?? "").length,
        fieldsOf(long).Organization?.value.endsWith("a…\n`acme`"),
      ],
      escapedTitle: [
        escaped.title.length <= 256,
        escaped.title.startsWith("Test: Deploy failed: \\*"),
        escaped.title.endsWith("\\*…"),
      ],
      escapedField: [
        organization.length <= 1024,
        name?.endsWith("\\*…"),
        organization.endsWith("\n`acme`"),
      ],
      code: (fieldsOf(escaped)["Failure code"]?.value ?? "").length,
    }).toStrictEqual({
      title: [256, true],
      field: [1024, true],
      escapedTitle: [true, true, true],
      escapedField: [true, true, true],
      code: 1024,
    });
  });

  it("posts a message's alerts as cards, up to Discord's ten", () => {
    const post = discordPostOf(
      messageWith([
        factsOf(deployFailed, { test: true }),
        factsOf(
          {
            kind: "deployed",
            clientId: "acme",
            releaseId: "26.11.8",
            failedAt: failedAt.getTime(),
          },
          { at: recoveredAt, test: true }
        ),
      ])
    );

    expect(embedsOf(post).map(({ title }) => title)).toStrictEqual([
      "Test: Deploy failed: Acme",
      "Test: Deploy recovered: Acme",
    ]);
  });

  it("falls back to the plain message, its subject in bold and escaped, when the cards can't be built or break a limit", () => {
    const broken = quietly(() =>
      discordPostOf(
        messageWith([factsOf(deployFailed, { at: new Date(Number.NaN) })])
      )
    );
    const eleven = quietly(() =>
      discordPostOf(
        messageWith(Array.from({ length: 11 }, () => factsOf(deployFailed)))
      )
    );
    // Five cards of a name at a field's limit: over 6000 characters in all.
    const heavy = quietly(() =>
      discordPostOf(
        messageWith(
          Array.from({ length: 5 }, () =>
            factsOf(deployFailed, {
              organization: { ...acme, name: "n".repeat(1100) },
            })
          )
        )
      )
    );
    const hostile = quietly(() =>
      discordPostOf({
        ...messageWith([]),
        subject: "@everyone [x](http://evil.test): deploy failed",
      })
    );
    const plainContent = `**Acme\\: deploy of 26.11.7 failed**\nThe deploy of release 26.11.7 to Acme \\(acme\\) failed \\(d1\\_migration\\_failed\\).\n${link}`;

    expect({
      broken,
      eleven,
      heavy,
      hostile: hostile.content?.split("\n")[0],
    }).toStrictEqual({
      broken: { content: plainContent },
      eleven: { content: plainContent },
      heavy: { content: plainContent },
      hostile:
        "**\\@everyone \\[x\\]\\(http\\://evil.test\\)\\: deploy failed**",
    });
  });
});
