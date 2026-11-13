import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { chatAuthority } from "../src/agent-scope.ts";
import { heldIn } from "../src/agent-skills.ts";
import {
  readSkillFor,
  selectSkillsFor,
  skillsFor,
} from "../src/brain-skills.ts";
import type { HeldNow, SkillsReach } from "../src/brain-skills.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { actingFor } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection, mailWithSearch } from "./mail-connection.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { holding, holdsNothing } from "./stored-skills.ts";
import { newTeam } from "./teams.ts";

// What a skill needs (GRA-1844), from the threat model on the issue: a
// skill selected where its caller can't do what it says, so the model is
// steered toward access it lacks; something of such a skill reaching the
// model; a skill taken as a grant. A skill declares the connections and
// tools it needs by the platform's own names; one whose needs the caller
// doesn't hold now is as if it weren't there.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A `SKILL.md` named `name`, for `description`, needing what `requires` says. */
const skillText = (name: string, description: string, requires = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${requires}---\n\nThe steps.\n`;

/** A chat's agent acting for `userId`. */
const agentOf = (userId: string) =>
  actingFor({ type: "agent", agentId: `agent-${unique()}` }, userId);

/** Every string in `value`, however deep: what a request to the model carried. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((each: unknown) => stringsIn(each));
  }
  return [];
};

describe("what a skill needs", setUpTime, () => {
  it("refuses a skill whose declaration of what it needs isn't the format's, when it is saved", async () => {
    const author = await signedInApi(idp, "user");
    const name = `send-it-${unique()}`;
    const save = async (requires: string) =>
      await outcome(author.api.skills.save(skillText(name, "Send", requires)));

    expect({
      notAList: await save("requires:\n  tools: mail.send\n"),
      notAProvider: await save("requires:\n  connections: [Not a provider]\n"),
      notATool: await save("requires:\n  tools: ['mail send']\n"),
      unknownKind: await save("requires:\n  roles: [admin]\n"),
      empty: await save("requires:\n  tools: []\n"),
      notAMap: await save("requires: mail\n"),
      both: await save(
        "requires:\n  connections: [microsoft]\n  tools: [mail.send]\n"
      ),
    }).toStrictEqual({
      notAList: "skills.invalid",
      notAProvider: "skills.invalid",
      notATool: "skills.invalid",
      unknownKind: "skills.invalid",
      empty: "skills.invalid",
      notAMap: "skills.invalid",
      both: "ok",
    });
  });

  it("lists, selects and reads a skill in a chat only once its agent holds the connection and tool it needs", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const suffix = unique();
    const needing = `send-the-tender-${suffix}`;
    const plain = `plan-the-tender-${suffix}`;
    const elsewhere = `book-the-tender-${suffix}`;
    await author.api.skills.save(
      skillText(
        needing,
        "Send the tender",
        "requires:\n  connections: [mail]\n  tools: [mail.send]\n"
      )
    );
    await author.api.skills.save(skillText(plain, "Plan the tender"));
    // A tool no connection the agent holds has.
    await author.api.skills.save(
      skillText(
        elsewhere,
        "Book the tender",
        "requires:\n  tools: [calendar.write]\n"
      )
    );
    // The chat's code: which of these skills are selected, and whether the
    // one that needs mail is read.
    const step = codeStep(
      `export default async (self, env) => {
        const { skills } = await env.skills.select({ task: "the tender" });
        const selected = skills.map(({ name }) => name).filter((name) => name.endsWith(${JSON.stringify(suffix)})).sort();
        let read = "read";
        try { await env.skills.read({ skill: { scope: "person", name: ${JSON.stringify(needing)}, version: 1 } }); } catch { read = "refused"; }
        return JSON.stringify({ selected, read });
      };`
    );
    const chat = await chatOf(
      author.userId,
      step,
      says("Done."),
      step,
      says("Done.")
    );
    await chat.ask("Send the tender.");
    const mail = await mailConnection([], mailWithSearch);
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send", "mail.search"],
      binding: "MAIL",
    });
    await chat.ask("Send the tender.");
    const results = await codeResults(chat.stub, chat.chat.id);
    const listedIn = (name: string) =>
      chat.provider.requests.map(({ body }) =>
        stringsIn(body).some((text) => text.includes(`- ${name} (person`))
      );

    expect({
      results: results.map(({ text }) => text),
      listed: {
        needing: listedIn(needing),
        plain: listedIn(plain),
        elsewhere: listedIn(elsewhere),
      },
    }).toStrictEqual({
      results: [
        `Returned:\n${JSON.stringify({ selected: [plain], read: "refused" })}`,
        `Returned:\n${JSON.stringify({ selected: [plain, needing].toSorted(), read: "read" })}`,
      ],
      listed: {
        needing: [false, false, true, true],
        plain: [true, true, true, true],
        elsewhere: [false, false, false, false],
      },
    });
  });

  it("lets a skill whose needs aren't met take no other's place: the one it would replace is given, as if it weren't there", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const team = await newTeam(author.userId);
    const name = `file-expenses-${unique()}`;
    const companyWay = await author.api.skills.save(
      skillText(name, "File them")
    );
    const forCompany = await author.api.skills.share(
      name,
      companyWay.version,
      "company"
    );
    await admin.api.skills.approve(forCompany.id);
    const teamWay = await author.api.skills.save(
      skillText(
        name,
        "File them in the ledger",
        "requires:\n  tools: [ledger.write]\n"
      )
    );
    const forTeam = await author.api.skills.share(name, teamWay.version, {
      team,
    });
    await admin.api.skills.approve(forTeam.id);
    const given = async (held: Parameters<typeof skillsFor>[3]) => {
      const listed = await skillsFor(
        env,
        agentOf(author.userId),
        "teams",
        held
      );
      return listed
        .filter((skill) => skill.name === name)
        .map(({ scope }) => scope);
    };
    const readTeams = async (held: Parameters<typeof skillsFor>[3]) =>
      await outcome(
        readSkillFor(env, agentOf(author.userId), "teams", held, {
          skill: { scope: "team", team, name, version: 1 },
        })
      );

    expect({
      lacking: await given(holdsNothing),
      holding: await given(holding({ tools: ["ledger.write"] })),
      readLacking: await readTeams(holdsNothing),
      readHolding: await readTeams(holding({ tools: ["ledger.write"] })),
    }).toStrictEqual({
      lacking: ["company"],
      holding: ["team"],
      readLacking: "skills.not_found",
      readHolding: "ok",
    });
  });

  it("holds nothing where connect can't be reached, or where others share the conversation: a skill that needs anything is then not listed, selected or read", async () => {
    const [author, admin] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "admin"),
    ]);
    const name = `mail-the-board-${unique()}`;
    const saved = await author.api.skills.save(
      skillText(name, "Mail the board", "requires:\n  tools: [mail.send]\n")
    );
    const share = await author.api.skills.share(name, saved.version, "company");
    await admin.api.skills.approve(share.id);
    const chat = await chatOf(author.userId);
    const mail = await mailConnection([], mailWithSearch);
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send", "mail.search"],
      binding: "MAIL",
    });
    const scope = {
      workspaceId: chat.id,
      agentId: chat.agent.agentId,
      chatId: chat.chat.id,
      personId: author.userId,
    };
    // Connect out of reach: asking whose connections are active fails.
    const unreachable: Env = {
      ...env,
      CONNECT: new Proxy(env.CONNECT, {
        get: (target, property): unknown =>
          property === "connectionOwners"
            ? async () => {
                await Promise.resolve();
                throw new Error("Out of reach, for the test");
              }
            : Reflect.get(target, property),
      }),
    };
    const authority = chatAuthority(scope);
    const given = async (held: HeldNow, reach: SkillsReach) => {
      const listed = await skillsFor(env, authority, reach, held);
      return listed.some((skill) => skill.name === name);
    };
    const read = async (held: HeldNow, reach: SkillsReach) =>
      await outcome(
        readSkillFor(env, authority, reach, held, {
          skill: { scope: "company", name, version: 1 },
        })
      );
    const selected = async (held: HeldNow) => {
      const skills = await selectSkillsFor(env, authority, "teams", held, {
        task: "mail the board",
      });
      return skills.some((skill) => skill.name === name);
    };
    const reachable = heldIn(env, scope, "teams");
    const outOfReach = heldIn(unreachable, scope, "teams");
    const shared = heldIn(env, scope, "company");

    expect({
      reachable: [
        await given(reachable, "teams"),
        await read(reachable, "teams"),
        await selected(reachable),
      ],
      outOfReach: [
        await given(outOfReach, "teams"),
        await read(outOfReach, "teams"),
        await selected(outOfReach),
      ],
      shared: [await given(shared, "company"), await read(shared, "company")],
    }).toStrictEqual({
      reachable: [true, "ok", true],
      outOfReach: [false, "skills.not_found", false],
      shared: [false, "skills.not_found"],
    });
  });
});
