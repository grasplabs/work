import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { startDueAgentWakes } from "../src/agent-wakes.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { personalWorkspaceId } from "../src/personal-workspace.ts";
import { codeResults, codeStep, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// An agent's wake-ups, as an admin's page makes them over `/rpc` and as
// core's clock fires them. These start from the ways it can fail: someone
// who isn't the company's own admin making one; one for someone who isn't
// a member, or for an agent the company doesn't have; a schedule that
// fires every minute; one time firing twice; a paused or deleted wake-up,
// or a paused agent's, firing; an agent that doesn't reach its person
// waking for them; a woken turn changing something.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const minuteMs = 60 * 1000;
const dayMs = 24 * 60 * minuteMs;

/** What an admin says of a wake-up for `personId`, with `over` its own. */
const said = (personId: string, over: Record<string, unknown> = {}) => ({
  cron: "0 9 * * *",
  timeZone: "UTC",
  personId,
  opening: "Look for invoices that are overdue and say which.",
  ...over,
});

/** The company's own admin and a member a wake-up can work for. */
const setUp = async () => {
  const admin = await signedInApi(idp, "admin");
  const person = await signedInApi(idp, "user");
  return { admin, person, wakes: admin.api.connections };
};

/** A moment after `wake` is next due. */
const dueOf = (wake: { nextAt: string | null }): Date =>
  new Date(Date.parse(wake.nextAt ?? "") + 1000);

/** The wake-up `id` of the first agent, as core keeps it now. */
const keptOf = async (
  wakes: Awaited<ReturnType<typeof setUp>>["wakes"],
  id: string,
  agentId: string = chatAgentId
) => {
  const all = await wakes.agentWakes(agentId);
  return all.find((each) => each.id === id);
};

/** `person`'s chats, once none of them runs. */
const settledChats = async (person: Awaited<ReturnType<typeof signedInApi>>) =>
  await vi.waitFor(
    async () => {
      const all = await person.api.chats.list();
      expect(all.every(({ running }) => !running)).toBeTruthy();
      return all;
    },
    { timeout: 10_000, interval: 50 }
  );

describe("an agent's wake-ups", setUpTime, () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM agent_wakes"),
      env.DB.prepare("DELETE FROM agents"),
      env.DB.prepare("DELETE FROM agent_reach"),
      env.DB.prepare("DELETE FROM agent_tool_classes"),
    ]);
  });

  it("are the company's own admins' alone: never a member's, never Grasp staff's", async () => {
    const { admin, person, wakes } = await setUp();
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    const made = await wakes.makeAgentWake(chatAgentId, said(person.userId));

    const tried = async (api: typeof wakes) => ({
      reads: await outcome(api.agentWakes(chatAgentId)),
      makes: await outcome(api.makeAgentWake(chatAgentId, said(admin.userId))),
      pauses: await outcome(api.setAgentWakePaused(made.id, true)),
      deletes: await outcome(api.deleteAgentWake(made.id)),
    });
    const refused = "role.forbidden";
    const all = {
      reads: refused,
      makes: refused,
      pauses: refused,
      deletes: refused,
    };
    expect({
      member: await tried(person.api.connections),
      staff: await tried(staff.connections),
    }).toStrictEqual({ member: all, staff: all });
    // Still there, on, as it was made.
    await expect(wakes.agentWakes(chatAgentId)).resolves.toMatchObject([
      { id: made.id, state: "on", personId: person.userId },
    ]);
  });

  it("refuse what isn't a wake-up, and keep nothing of it", async () => {
    const { person, wakes } = await setUp();
    const mine = (over: Record<string, unknown>) => said(person.userId, over);
    await expect(
      Promise.all([
        outcome(wakes.makeAgentWake("agent-there-is-none", mine({}))),
        // Every minute, and every half hour: more often than hourly.
        outcome(wakes.makeAgentWake(chatAgentId, mine({ cron: "* * * * *" }))),
        outcome(
          wakes.makeAgentWake(chatAgentId, mine({ cron: "*/30 * * * *" }))
        ),
        outcome(wakes.makeAgentWake(chatAgentId, mine({ cron: "soon" }))),
        // The 30th of February never comes.
        outcome(wakes.makeAgentWake(chatAgentId, mine({ cron: "0 9 30 2 *" }))),
        outcome(
          wakes.makeAgentWake(chatAgentId, mine({ timeZone: "Mars/Olympus" }))
        ),
        outcome(wakes.makeAgentWake(chatAgentId, mine({ opening: "  " }))),
        outcome(wakes.makeAgentWake(chatAgentId, said("nobody-of-ours"))),
        outcome(wakes.setAgentWakePaused("wake-there-is-none", true)),
        outcome(wakes.deleteAgentWake("wake-there-is-none")),
      ])
    ).resolves.toStrictEqual([
      "agent.unknown",
      "agent.wake_invalid",
      "agent.wake_invalid",
      "agent.wake_invalid",
      "agent.wake_invalid",
      "agent.wake_invalid",
      "agent.wake_invalid",
      "agent.wake_invalid",
      "agent.wake_unknown",
      "agent.wake_unknown",
    ]);
    await expect(wakes.agentWakes(chatAgentId)).resolves.toStrictEqual([]);
  });

  it("fire once for each time the schedule names, however often the clock runs, in a chat of the person's with that agent", async () => {
    const { person, wakes } = await setUp();
    const gateway = await fakeProvider(says("Two are overdue."));
    const made = await wakes.makeAgentWake(chatAgentId, said(person.userId));
    const due = dueOf(made);

    // Not due yet: nothing starts.
    await startDueAgentWakes(env, new Date(due.getTime() - minuteMs));
    await expect(settledChats(person)).resolves.toStrictEqual([]);

    await Promise.all([
      startDueAgentWakes(env, due),
      startDueAgentWakes(env, due),
    ]);
    await startDueAgentWakes(env, new Date(due.getTime() + minuteMs));
    const chats = await settledChats(person);
    const kept = await keptOf(wakes, made.id);
    expect({
      chats: chats.length,
      asked: gateway.requests.length,
      lastOutcome: kept?.lastOutcome,
      // On to tomorrow's nine o'clock.
      next: Date.parse(kept?.nextAt ?? "") - Date.parse(made.nextAt ?? ""),
    }).toStrictEqual({
      chats: 1,
      asked: 1,
      lastOutcome: "started",
      next: dayMs,
    });
    expect(JSON.stringify(gateway.requests)).toContain(
      "Look for invoices that are overdue and say which."
    );

    // The next day's fire goes into the same chat.
    await startDueAgentWakes(env, new Date(due.getTime() + dayMs));
    await expect(settledChats(person)).resolves.toHaveLength(1);
    expect(gateway.requests).toHaveLength(2);
  });

  it("don't fire while paused or once deleted, and count the times slept through as none", async () => {
    const { person, wakes } = await setUp();
    const gateway = await fakeProvider(says("Nothing."));
    const paused = await wakes.makeAgentWake(chatAgentId, said(person.userId));
    const deleted = await wakes.makeAgentWake(chatAgentId, said(person.userId));
    await wakes.setAgentWakePaused(paused.id, true);
    await wakes.deleteAgentWake(deleted.id);

    await startDueAgentWakes(env, dueOf(paused));
    const during = await keptOf(wakes, paused.id);
    await wakes.setAgentWakePaused(paused.id, false);
    const after = await keptOf(wakes, paused.id);
    const left = await wakes.agentWakes(chatAgentId);
    expect({
      chats: await settledChats(person),
      asked: gateway.requests.length,
      during: [during?.state, during?.nextAt],
      // On again: its next time is one to come, not one it slept through.
      future: Date.parse(after?.nextAt ?? "") > Date.now(),
      left: left.map(({ id }) => id),
    }).toStrictEqual({
      chats: [],
      asked: 0,
      during: ["paused", null],
      future: true,
      left: [paused.id],
    });
  });

  it("start no turn of a paused agent: tried once more, then left until the next time, with why kept", async () => {
    const { person, wakes } = await setUp();
    const gateway = await fakeProvider(says("Nothing."));
    const made = await wakes.makeAgentWake(chatAgentId, said(person.userId));
    await wakes.setAgentPaused(chatAgentId, true);
    const due = dueOf(made);

    await startDueAgentWakes(env, due);
    const first = await keptOf(wakes, made.id);
    // Its one retry, a few minutes on; then none until tomorrow.
    await startDueAgentWakes(env, new Date(due.getTime() + 6 * minuteMs));
    await startDueAgentWakes(env, new Date(due.getTime() + 12 * minuteMs));
    await wakes.setAgentPaused(chatAgentId, false);
    await startDueAgentWakes(env, new Date(due.getTime() + 18 * minuteMs));
    expect({
      first: first?.lastOutcome,
      chats: await settledChats(person),
      asked: gateway.requests.length,
    }).toStrictEqual({ first: "agent.paused", chats: [], asked: 0 });

    // Tomorrow, with the agent on again, it wakes.
    await startDueAgentWakes(env, new Date(due.getTime() + dayMs));
    await expect(settledChats(person)).resolves.toHaveLength(1);
    await expect(keptOf(wakes, made.id)).resolves.toMatchObject({
      lastOutcome: "started",
    });
  });

  it("wake no agent for someone it doesn't reach, and make them no chat", async () => {
    const { person, wakes } = await setUp();
    const gateway = await fakeProvider(says("Nothing."));
    // A new agent reaches nobody until an admin says otherwise.
    const claire = await wakes.makeAgent({
      name: "Claire",
      face: "claire",
      job: "Chases unpaid invoices.",
      instructions: "",
      modelRole: null,
    });
    const made = await wakes.makeAgentWake(claire.id, said(person.userId));
    await startDueAgentWakes(env, dueOf(made));
    const refused = await keptOf(wakes, made.id, claire.id);
    expect({
      outcome: refused?.lastOutcome,
      chats: await person.api.chats.list(),
      asked: gateway.requests.length,
    }).toStrictEqual({ outcome: "agent.not_for_you", chats: [], asked: 0 });

    // Reaching them, it wakes for them, in a chat of its own.
    await wakes.setAgentReach(claire.id, true, { who: "everyone" });
    await startDueAgentWakes(env, new Date(dueOf(made).getTime() + dayMs));
    await expect(settledChats(person)).resolves.toHaveLength(1);
  });

  it("wake the agent to a turn that only reads", async () => {
    const { person, wakes } = await setUp();
    await fakeProvider(
      codeStep(
        "export default async (self, env) => { try { await env.memory.saveUser({ text: 'Prefers short answers.', ifVersion: 0 }); return 'saved'; } catch (error) { return error.message; } };"
      ),
      says("I couldn't keep that.")
    );
    const made = await wakes.makeAgentWake(chatAgentId, said(person.userId));
    await startDueAgentWakes(env, dueOf(made));
    const [chat] = await settledChats(person);
    const results = await codeResults(
      workspace(env, personalWorkspaceId(person.userId)),
      chat?.id ?? ""
    );
    expect(results.map(({ text }) => text)).toStrictEqual([
      "Returned:\nNobody asked for this just now, so the agent can only read. What it wants to change waits for its person.",
    ]);
  });
});
