import { agentIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { requireAgentHasApp } from "../src/agent-app-gate.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { saveInstructions } from "./instruction-saves.ts";
import { fakeProvider } from "./model-provider.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// An agent's apps (GRA-1852): whoever manages an agent gives it apps the
// company offers, by hand or worked out from its instructions, and an
// agent with apps listed uses only those. These start from the ways it
// can fail: an agent using an app it doesn't have, or one taken off; an
// app the company doesn't offer added; an app someone took off coming
// back; a kind of work that changes things turned on without a person;
// someone who doesn't manage the agent changing its apps.

const idp = mockIdp();

const slow = { timeout: 60_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

const said = (name: string) => ({
  name,
  face: "pen",
  job: "Answers HR questions.",
  modelRole: null,
});

/**
 * Tells the agent `agentId` to read Gmail, in its instruction file as
 * `person` saves it on its page, with a word of its own: the text the
 * model must be given to work its apps out. Returns that word.
 */
const toldGmail = async (person: Person, agentId: string): Promise<string> => {
  const word = `weekly-${crypto.randomUUID()}`;
  await saveInstructions(
    person.api,
    { scope: "agent", agentId },
    `Check incoming email in Gmail once a week and sum it up (${word}).`
  );
  return word;
};

/** Whether a call of `agentId` for `person` to `app` is let through. */
const gate = async (agentId: string, person: Person, app: string) =>
  await outcome(
    requireAgentHasApp(
      env,
      {
        subject: { type: "agent", agentId: agentIdSchema.parse(agentId) },
        onBehalfOf: person.userId,
        mode: "interactive",
      },
      app
    )
  );

/** The model reads the agent and answers `answer`. */
const answering = async (answer: object) =>
  await fakeProvider({
    text: JSON.stringify(answer),
    inputTokens: 40,
    outputTokens: 20,
  });

describe("an agent's apps", slow, () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM agents"),
      env.DB.prepare("DELETE FROM agent_reach"),
      env.DB.prepare("DELETE FROM agent_tool_classes"),
      env.DB.prepare("DELETE FROM agent_apps"),
      env.DB.prepare("DELETE FROM hidden_connectors"),
    ]);
  });

  it("are given and taken off by whoever manages the agent, only from what the company offers, and hold its calls", async () => {
    const admin = await signedInApi(idp, "admin");
    const user = await signedInApi(idp, "user");
    const hr = await admin.api.connections.makeAgent(said("HR"));
    const { connections } = admin.api;

    const before = await gate(hr.id, user, "native:microsoft");
    const refused = {
      byUser: await outcome(
        user.api.connections.setAgentApp(hr.id, "native:google", true)
      ),
      unknown: await outcome(
        connections.setAgentApp(hr.id, "composio:nothing", true)
      ),
      first: await outcome(
        connections.setAgentApp("organization", "native:google", true)
      ),
    };
    await connections.setAgentApp(hr.id, "native:google", true);
    const withGoogle = {
      google: await gate(hr.id, user, "native:google"),
      microsoft: await gate(hr.id, user, "native:microsoft"),
      // The company's first agent lists none: as before agents had apps.
      first: await gate("organization", user, "native:microsoft"),
    };
    await connections.setAgentApp(hr.id, "native:google", false);
    const listed = await connections.agentApps(hr.id);
    const events = await allEvents();

    expect({
      before,
      refused,
      withGoogle,
      afterRemoved: await gate(hr.id, user, "native:google"),
      listed,
      byUser: await outcome(user.api.connections.agentApps(hr.id)),
      recorded: events
        .filter(
          ({ action, target }) =>
            action === "agent.app.changed" && target?.id === hr.id
        )
        .map(({ detail }) => detail),
    }).toStrictEqual({
      before: "ok",
      refused: {
        byUser: "role.forbidden",
        unknown: "agent.app_unknown",
        first: "agent.app_unknown",
      },
      withGoogle: {
        google: "ok",
        microsoft: "connect.agent_app_off",
        first: "ok",
      },
      afterRemoved: "connect.agent_app_off",
      listed: [
        {
          app: "native:google",
          name: "Google Workspace",
          state: "removed",
          source: "person",
        },
      ],
      byUser: "role.forbidden",
      recorded: [
        { app: "native:google", on: "true" },
        { app: "native:google", on: "false" },
      ],
    });
  });

  it("are worked out from its instructions: only apps offered and not taken off, reading turned on, changing only suggested", async () => {
    const admin = await signedInApi(idp, "admin");
    const user = await signedInApi(idp, "user");
    const hr = await admin.api.connections.makeAgent(said("HR"));
    const word = await toldGmail(admin, hr.id);
    const { connections } = admin.api;
    // Someone took HubSpot off before; the company hides Microsoft.
    await connections.setAgentApp(hr.id, "composio:hubspot", false);
    await env.DB.prepare(
      "INSERT INTO hidden_connectors (source, connector_id, hidden_by, hidden_at) VALUES ('native', 'microsoft', ?, ?)"
    )
      .bind(admin.userId, Date.now())
      .run();
    const provider = await answering({
      apps: [
        "native:google",
        "composio:hubspot",
        "native:microsoft",
        "composio:nothing",
      ],
      kinds: ["read-own", "reach-others"],
      missing: ["Slack"],
    });

    const byUser = await outcome(user.api.connections.workOutAgentApps(hr.id));
    const worked = await connections.workOutAgentApps(hr.id);
    const settings = await connections.agentSettings(hr.id);
    const listed = await connections.agentApps(hr.id);
    const events = await allEvents();
    const recorded = events
      .filter(
        ({ action, detail }) =>
          (action === "agent.app.changed" &&
            detail?.source === "instructions") ||
          (action === "agent.class.changed" && detail?.agent === hr.id)
      )
      .filter(
        ({ target, detail }) => target?.id === hr.id || detail?.agent === hr.id
      )
      .map(({ action, detail }) => [action, detail?.app ?? detail?.toolClass]);

    expect({
      // What it is told, from its instruction file in the Brain.
      toldTheModel: provider.requests.map(({ body }) =>
        JSON.stringify(body).includes(word)
      ),
      byUser,
      recorded,
      worked,
      listed: listed.map(({ app, state, source }) => [app, state, source]),
      classes: settings.classes
        .filter(({ audience }) => audience.who !== "nobody")
        .map(({ toolClass }) => toolClass),
    }).toStrictEqual({
      toldTheModel: [true],
      byUser: "role.forbidden",
      // Each change it made, and none it didn't.
      recorded: [
        ["agent.app.changed", "native:google"],
        ["agent.class.changed", "read-own"],
      ],
      worked: {
        added: [
          {
            app: "native:google",
            name: "Google Workspace",
            state: "on",
            source: "instructions",
          },
        ],
        suggested: ["reach-others"],
        turnedOn: ["read-own"],
        missing: ["Slack"],
      },
      listed: [
        ["native:google", "on", "instructions"],
        ["composio:hubspot", "removed", "person"],
      ],
      classes: ["read-own"],
    });
  });

  it("are worked out for a person's own agent by its owner, from the file only they read, turning on no kind of work of its own", async () => {
    const ann = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const mine = await ann.api.connections.makeOwnAgent(said("Scribe"));
    const word = await toldGmail(ann, mine.id);
    const provider = await answering({
      apps: ["native:google"],
      kinds: ["read-own", "change-own"],
      missing: [],
      // Never proposed for an agent of one's own, which never wakes.
      schedule: { cron: "0 8 * * 1", opening: "Sum up the week." },
    });
    // An admin can't have it worked out, as for an agent no one made.
    const byAdmin = await outcome(
      admin.api.connections.workOutAgentApps(mine.id)
    );
    const worked = await ann.api.connections.workOutAgentApps(mine.id);
    expect({
      byAdmin,
      toldTheModel: provider.requests.map(({ body }) =>
        JSON.stringify(body).includes(word)
      ),
    }).toStrictEqual({ byAdmin: "agent.unknown", toldTheModel: [true] });
    expect(worked).toStrictEqual({
      added: [
        {
          app: "native:google",
          name: "Google Workspace",
          state: "on",
          source: "instructions",
        },
      ],
      suggested: [],
      turnedOn: [],
      missing: [],
    });
  });

  it("proposes when a company agent works on its own, as a wake-up takes it, and makes none", async () => {
    const admin = await signedInApi(idp, "admin");
    const weekly = await admin.api.connections.makeAgent(said("Weekly"));
    const often = await admin.api.connections.makeAgent(said("Often"));
    await answering({
      apps: [],
      kinds: [],
      missing: [],
      schedule: { cron: "0 8 * * 1", opening: "Sum up HR's new mail." },
    });
    const proposed = await admin.api.connections.workOutAgentApps(weekly.id);
    await answering({
      apps: [],
      kinds: [],
      missing: [],
      schedule: { cron: "* * * * *", opening: "Check again." },
    });
    const tooOften = await admin.api.connections.workOutAgentApps(often.id);
    const wakes = await admin.api.connections.agentWakes(weekly.id);

    expect({
      proposed: proposed.schedule,
      tooOften: tooOften.schedule,
      wakes,
    }).toStrictEqual({
      proposed: { cron: "0 8 * * 1", opening: "Sum up HR's new mail." },
      tooOften: undefined,
      wakes: [],
    });
  });
});
