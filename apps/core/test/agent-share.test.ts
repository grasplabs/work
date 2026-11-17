import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { saveInstructions } from "./instruction-saves.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// A person's own agent offered to the company: its owner offers it, and
// the company's own admins take it on or decline it. These start from the
// ways it can fail: someone but its owner offering it; admins reading one
// nobody offered them; someone but the company's own admin taking it on;
// one taken on that reaches anyone or may do anything before an admin
// says so, or that its owner still changes; one taken on after its owner
// took the offer back; a company name taken twice; its name in the audit
// log before its owner offered it.

const idp = mockIdp();

const slow = { timeout: 60_000 };

const said = (name: string) => ({
  name,
  face: "pen",
  job: "Drafts weekly client notes.",
  modelRole: null,
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("a person's own agent offered to the company", slow, () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM agents"),
      env.DB.prepare("DELETE FROM agent_reach"),
      env.DB.prepare("DELETE FROM agent_tool_classes"),
      env.DB.prepare("DELETE FROM agent_documents"),
    ]);
  });

  it("is offered by its owner alone, and read by admins only once offered", async () => {
    const ann = await signedInApi(idp, "user");
    const ben = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const mine = await ann.api.connections.makeOwnAgent(said("Scribe"));
    const told = { scope: "agent", agentId: mine.id } as const;
    await saveInstructions(ann.api, told, "Short sentences, no greetings.");
    const listedBefore = await admin.api.connections.offeredAgents();

    const refused = {
      ben: await outcome(ben.api.connections.offerOwnAgent(mine.id, true)),
      admin: await outcome(admin.api.connections.offerOwnAgent(mine.id, true)),
    };
    await ann.api.connections.offerOwnAgent(mine.id, true);
    const offered = await admin.api.connections.offeredAgents();
    const events = await allEvents();
    const recorded = events.filter(({ target }) => target?.id === mine.id);
    const companys = await admin.api.connections.agents();

    expect({
      listedBefore,
      refused,
      offered: offered.map(({ id, name, ownerId }) => [id, name, ownerId]),
      // What it is told stays its owner's alone, offered or not.
      adminReads: await outcome(admin.api.instructions.read(told)),
      byUser: await outcome(ben.api.connections.offeredAgents()),
      // Still its owner's, and still none of the company's.
      companys: companys.some(({ id }) => id === mine.id),
      recorded: recorded.map(({ action, detail }) => [action, detail]),
      named: JSON.stringify(recorded).includes("Scribe"),
    }).toStrictEqual({
      listedBefore: [],
      refused: { ben: "role.forbidden", admin: "agent.unknown" },
      offered: [[mine.id, "Scribe", ann.userId]],
      adminReads: "agent.unknown",
      byUser: "role.forbidden",
      companys: false,
      recorded: [
        ["agent.made", { own: "true" }],
        ["agent.offered", { offered: "true" }],
      ],
      named: false,
    });
  });

  it("is taken on by the company's own admin as one that reaches nobody and may do nothing yet, on though its owner paused it, with what its owner gave it, and its owner no longer changes it", async () => {
    const ann = await signedInApi(idp, "user");
    const user = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const mine = await ann.api.connections.makeOwnAgent(said("Scribe"));
    await ann.api.connections.addAgentDocument(mine.id, {
      name: "style.md",
      bytes: utf8("Short."),
    });
    await ann.api.connections.setAgentPaused(mine.id, true);
    await ann.api.connections.offerOwnAgent(mine.id, true);

    const byUser = await outcome(user.api.connections.adoptAgent(mine.id));
    await admin.api.connections.adoptAgent(mine.id);
    const companys = await admin.api.connections.agents();
    const settings = await admin.api.connections.agentSettings(mine.id);
    const documents = await admin.api.connections.agentDocuments(mine.id);
    const ownersNow = await ann.api.connections.ownAgents();

    expect({
      byUser,
      taken: companys
        .filter(({ id }) => id === mine.id)
        .map(({ name, ownerId, offeredAt, state }) => [
          name,
          ownerId,
          offeredAt,
          state,
        ]),
      reaches: settings.audience,
      classes: [
        ...new Set(settings.classes.map(({ audience }) => audience.who)),
      ],
      documents: documents.map(({ name }) => name),
      ownersNow: ownersNow.map(({ id }) => id),
      ownerChanges: await outcome(
        ann.api.connections.changeAgent(mine.id, said("Mine again"))
      ),
      ownerRemoves: await outcome(
        ann.api.connections.removeAgentDocument(mine.id, documents[0]?.id ?? "")
      ),
      ownerDeletes: await outcome(ann.api.connections.deleteAgent(mine.id)),
      again: await outcome(admin.api.connections.adoptAgent(mine.id)),
    }).toStrictEqual({
      byUser: "role.forbidden",
      taken: [["Scribe", null, null, "on"]],
      reaches: { who: "nobody" },
      classes: ["nobody"],
      documents: ["style.md"],
      ownersNow: [],
      ownerChanges: "role.forbidden",
      ownerRemoves: "role.forbidden",
      ownerDeletes: "role.forbidden",
      again: "agent.not_offered",
    });
  });

  it("keeps what an admin gave the agent it took on when a later call to take it on comes in", async () => {
    const ann = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const mine = await ann.api.connections.makeOwnAgent(said("Scribe"));
    await ann.api.connections.offerOwnAgent(mine.id, true);
    await admin.api.connections.adoptAgent(mine.id);
    await admin.api.connections.setAgentToolClass(mine.id, "read-own", {
      who: "everyone",
    });

    const again = await outcome(admin.api.connections.adoptAgent(mine.id));
    const settings = await admin.api.connections.agentSettings(mine.id);

    expect({
      again,
      readOwn: settings.classes.find(
        ({ toolClass }) => toolClass === "read-own"
      )?.audience,
    }).toStrictEqual({
      again: "agent.not_offered",
      readOwn: { who: "everyone" },
    });
  });

  it("isn't taken on once its owner took the offer back or an admin declined it, nor under a name the company already has", async () => {
    const ann = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const back = await ann.api.connections.makeOwnAgent(said("Back"));
    await ann.api.connections.offerOwnAgent(back.id, true);
    await ann.api.connections.offerOwnAgent(back.id, false);
    const declined = await ann.api.connections.makeOwnAgent(said("Declined"));
    await ann.api.connections.offerOwnAgent(declined.id, true);
    await admin.api.connections.declineAgent(declined.id);
    await admin.api.connections.makeAgent(said("Claire"));
    const clash = await ann.api.connections.makeOwnAgent(said("claire"));
    await ann.api.connections.offerOwnAgent(clash.id, true);
    const tried = {
      back: await outcome(admin.api.connections.adoptAgent(back.id)),
      declined: await outcome(admin.api.connections.adoptAgent(declined.id)),
      clash: await outcome(admin.api.connections.adoptAgent(clash.id)),
    };
    const owned = await ann.api.connections.ownAgents();

    expect({
      ...tried,
      // All three still their owner's; the clashing one still offered.
      owners: owned.map(({ name, offeredAt }) => [name, offeredAt !== null]),
    }).toStrictEqual({
      back: "agent.not_offered",
      declined: "agent.not_offered",
      clash: "agent.name_taken",
      owners: [
        ["Back", false],
        ["claire", true],
        ["Declined", false],
      ],
    });
  });
});
