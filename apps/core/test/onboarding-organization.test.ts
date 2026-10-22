import { addWorkingDays, addDays } from "@grasp-os/shared/admin/org-record";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type {
  InterviewProgress,
  InterviewSaved,
} from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import type {
  OrganizationChangeInput,
  StaffOrganization,
} from "@grasp-os/shared/onboarding-organization";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { answering } from "./interview-link.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// The organization as Grasp's staff see it and put it right, over `/rpc`
// (src/onboarding/organization.ts, the store and staff-rpc.ts). AI Gateway,
// which draws a team's map, is the outside system. The ways it can fail,
// tried here:
//
// - Anyone but staff reading who works where, or changing it.
// - A read that names people, or a change, without a trace; or one that
//   names the person in the audit log, which the company's admin reads.
// - Someone moved still asked about their old team's work, or kept as
//   doing it though they never talked about it.
// - A team asked in late sending everyone at once, past its lead.
// - A link sent now while the interviews are paused.

const idp = mockIdp();
const dayMs = 24 * 60 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);
/** A time on `day`, in the morning. */
const at = (day: string) => `${day}T09:00:00.000Z`;
const sessionKey = z.object({ key: z.string().optional() });

/** Grasp's staff, on a connection of their own, and a change they make. */
const asStaff = async () => {
  const session = await signedIn(idp, "grasp-staff", staffPerson());
  const { core } = await openRpc(session);
  const api = core.authenticate();
  const change = async (made: OrganizationChangeInput) => {
    await api.onboardingStaff.changeOrganization(made);
  };
  return { staff: api, change };
};

/**
 * An onboarding running for `since` days: Ops, led by Lea, with Max and
 * Mia; Sales, led by Sol, with Sam, taking part unless `salesOff`.
 */
const running = async (since: number, salesOff = false) => {
  const store = onboardingStore(env);
  const id = unique();
  const ids = {
    ops: `ops-${id}`,
    sales: `sales-${id}`,
    lea: `lea-${id}`,
    max: `max-${id}`,
    mia: `mia-${id}`,
    sol: `sol-${id}`,
    sam: `sam-${id}`,
  };
  const person = (key: keyof typeof ids, name: string, team: string) => ({
    id: ids[key],
    name,
    team,
    email: "",
    title: "",
    away: false,
  });
  const roster: Roster = {
    teams: [
      { id: ids.ops, name: "Ops", lead: ids.lea, does: "", off: false },
      { id: ids.sales, name: "Sales", lead: ids.sol, does: "", off: salesOff },
    ],
    people: [
      person("lea", "Lea Lind", ids.ops),
      person("max", "Max Mol", ids.ops),
      person("mia", "Mia Moor", ids.ops),
      person("sol", "Sol Sand", ids.sales),
      person("sam", "Sam Smit", ids.sales),
    ],
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan(
    {
      start: new Date(Date.now() - since * dayMs).toISOString().slice(0, 10),
      days: 14,
    },
    by
  );
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  return ids;
};

const progressOf = (record: string): InterviewProgress => ({
  person: "completed",
  told: true,
  mode: "type",
  lines: [{ from: "stephen", text: "What does your team do?" }],
  facts: [{ id: "f1", tag: "work", text: record, record, agreed: true }],
  phase: "readback",
  wants: "end",
  startedAt: Date.now(),
  confirmed: 1,
  adding: false,
  addedAt: 0,
});

/** Lea talks and agrees, and Ops' map is drawn: tickets (Max, Mia) and the rota (Lea). */
const mapOps = async (ids: Awaited<ReturnType<typeof running>>) => {
  const store = onboardingStore(env);
  const link = await store.linkOf(ids.lea);
  const secret = link?.split("#")[1] ?? "";
  const session = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  const { key } = sessionKey.parse(await session.json());
  const saved = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "save",
      secret,
      key,
      version: 0,
      progress: progressOf("Max and Mia handle tickets; Lea plans the rota."),
    }),
  });
  const { version }: InterviewSaved = await saved.json();
  expect(version).toBe(1);
  const reply: GatewayReply = {
    text: JSON.stringify({
      does: "Answers customers' questions",
      works: [
        {
          name: "handling tickets",
          local: "handling tickets",
          one: "ticket",
          many: "tickets",
          doers: [ids.max, ids.mia],
          share: 0.7,
        },
        {
          name: "planning the rota",
          local: "planning the rota",
          one: "rota",
          many: "rotas",
          doers: [ids.lea],
          share: 0.3,
        },
      ],
    }),
    inputTokens: 100,
    outputTokens: 100,
  };
  await answering([reply], async () => await store.drawNext());
  const [tickets, rota] = await store.teamWorks(ids.ops);
  return { tickets: tickets?.id ?? "", rota: rota?.id ?? "" };
};

describe("the organization, for Grasp's staff", { timeout: 60_000 }, () => {
  it("is staff's alone: a member and the company's admin neither read nor change it", async () => {
    const { api: admin } = await signedInApi(idp, "admin");
    const { api: user } = await signedInApi(idp, "user");
    const refused = await Promise.all(
      [admin, user].flatMap((api) => [
        outcome(api.onboardingStaff.organization()),
        outcome(
          api.onboardingStaff.changeOrganization({
            kind: "addTeam",
            name: "Finance",
          })
        ),
      ])
    );
    expect(new Set(refused)).toStrictEqual(new Set(["onboarding.staff_only"]));
  });

  it("shows every team with its lead, its people and where each stands, and puts each read in the audit log without a name", async () => {
    const ids = await running(1);
    const { staff } = await asStaff();

    const reads: StaffOrganization[] = [];
    const events = await auditedDuring(async () => {
      reads.push(await staff.onboardingStaff.organization());
    });

    const [organization] = reads;
    const text = JSON.stringify(events);
    expect({
      teams: organization?.teams.map(({ name, lead, turn }) => ({
        name,
        lead,
        turn: turn.kind,
      })),
      people: organization?.people.map(({ name, state, lead }) => [
        name,
        state,
        lead,
      ]),
      actions: events.map(({ action, actor }) => [action, actor.type]),
      names: text.includes(ids.lea) || text.includes("Lea Lind"),
    }).toStrictEqual({
      teams: [
        { name: "Ops", lead: ids.lea, turn: "lead" },
        { name: "Sales", lead: ids.sol, turn: "lead" },
      ],
      people: [
        ["Lea Lind", "sent", true],
        ["Max Mol", "waiting", false],
        ["Mia Moor", "waiting", false],
        ["Sol Sand", "sent", true],
        ["Sam Smit", "waiting", false],
      ],
      actions: [["onboarding.organization.read", "staff"]],
      names: false,
    });
  });

  it("asks someone moved about their new team's work, and no longer counts them for the old team's", async () => {
    const ids = await running(1);
    const { tickets, rota } = await mapOps(ids);
    const { staff, change } = await asStaff();

    // Sam moves to Ops, which has a map; Max to Sales, which has none.
    const events = await auditedDuring(async () => {
      await change({
        kind: "editPerson",
        person: ids.sam,
        name: "Sam Smit",
        team: ids.ops,
      });
      await change({
        kind: "editPerson",
        person: ids.max,
        name: "Max Mol",
        team: ids.sales,
      });
    });
    const { teams, people } = await staff.onboardingStaff.organization();
    const ops = teams.find(({ id }) => id === ids.ops);
    const workOf = (id: string) => people.find((one) => one.id === id)?.work;
    const { entries } = await staff.onboardingStaff.log({ actor: "staff" });
    const text = JSON.stringify(events);
    expect({
      sam: workOf(ids.sam),
      max: workOf(ids.max),
      works: ops?.works.map(({ id, doers }) => [id, doers]),
      log: entries
        .slice(0, 2)
        .map(({ what, person }) => [what, person?.id])
        .toReversed(),
      audit: events
        .filter(({ actor }) => actor.type === "staff")
        .map(({ action }) => action),
      names: [ids.sam, ids.max, "Sam Smit", "Max Mol"].some((name) =>
        text.includes(name)
      ),
    }).toStrictEqual({
      // The rota is the least heard of: only Lea does it, and she leads.
      sam: rota,
      max: null,
      works: [
        [tickets, [ids.mia]],
        [rota, [ids.lea, ids.sam]],
      ],
      log: [
        ["onboarding.person.moved", ids.sam],
        ["onboarding.person.moved", ids.max],
      ],
      audit: ["onboarding.person.moved", "onboarding.person.moved"],
      names: false,
    });
  });

  it("keeps someone who talked with the work they told about, when they move", async () => {
    const ids = await running(1);
    const { rota } = await mapOps(ids);
    const { staff, change } = await asStaff();
    // Lea, who told about the rota, moves to Sales; Ops is left without a lead.
    await change({
      kind: "editPerson",
      person: ids.lea,
      name: "Lea Lind",
      team: ids.sales,
    });
    const { teams } = await staff.onboardingStaff.organization();
    const ops = teams.find(({ id }) => id === ids.ops);
    const works = await onboardingStore(env).teamWorks(ids.ops);
    expect({
      lead: ops?.lead,
      flags: ops?.flags.map(({ kind }) => kind),
      rota: works.find(({ id }) => id === rota)?.doers,
    }).toStrictEqual({
      lead: null,
      flags: ["noLead"],
      rota: [ids.lea],
    });
  });

  it("gives a team asked in late its lead's three working days, from the day it was asked in", async () => {
    const ids = await running(10, true);
    const store = onboardingStore(env);
    const { staff, change } = await asStaff();

    const first = await staff.onboardingStaff.organization();
    const before = first.teams.find(({ id }) => id === ids.sales)?.turn;
    await change({ kind: "takesPart", team: ids.sales, takes: true });
    const { teams, people } = await staff.onboardingStaff.organization();
    const by = addWorkingDays(today(), 3);
    const early = await store.releaseDue(at(addDays(by, -1)));
    const due = await store.releaseDue(at(by));
    expect({
      before,
      turn: teams.find(({ id }) => id === ids.sales)?.turn,
      sol: people.find(({ id }) => id === ids.sol)?.state,
      sam: people.find(({ id }) => id === ids.sam)?.state,
      early,
      due,
    }).toStrictEqual({
      before: { kind: "off" },
      turn: { kind: "lead", lead: "Sol Sand", by },
      sol: "sent",
      sam: "waiting",
      early: [],
      due: [ids.sam],
    });
  });

  it("puts the list right: a team added and renamed, a lead picked, someone added, away and taken off", async () => {
    const ids = await running(1);
    const { staff, change } = await asStaff();
    await change({ kind: "addTeam", name: "Finance", does: "Pays bills" });
    const first = await staff.onboardingStaff.organization();
    const added = first.teams.find(({ name }) => name === "Finance");
    const team = added?.id ?? "";
    await change({ kind: "editTeam", team, name: "Money", does: "Pays" });
    await change({ kind: "addPerson", name: "Fay Fox", team });
    const second = await staff.onboardingStaff.organization();
    const fay = second.people.find(({ name }) => name === "Fay Fox")?.id ?? "";
    await change({ kind: "lead", team, person: fay });
    await change({ kind: "away", person: ids.mia, away: true });
    await change({ kind: "removePerson", person: ids.max });
    const { teams, people } = await staff.onboardingStaff.organization();
    const { entries } = await staff.onboardingStaff.log({ actor: "staff" });
    expect({
      money: teams
        .filter(({ id }) => id === team)
        .map(({ name, does, lead }) => ({ name, does, lead })),
      fay: people.find(({ id }) => id === fay)?.lead,
      mia: people.find(({ id }) => id === ids.mia)?.state,
      max: people.some(({ id }) => id === ids.max),
      log: entries
        .slice(0, 6)
        .map(({ what }) => what)
        .toReversed(),
    }).toStrictEqual({
      money: [{ name: "Money", does: "Pays", lead: fay }],
      fay: true,
      mia: "away",
      max: false,
      log: [
        "onboarding.team.added",
        "onboarding.team.changed",
        "onboarding.person.added",
        "onboarding.team.lead_set",
        "onboarding.person.away",
        "onboarding.person.removed",
      ],
    });
  });

  it("sends a link now while the interviews run, and asks someone about a piece of their team's work", async () => {
    const ids = await running(1);
    const { rota } = await mapOps(ids);
    const { staff, change } = await asStaff();
    const store = onboardingStore(env);

    await store.setPaused(true, { type: "system" });
    const paused = await outcome(change({ kind: "send", person: ids.sam }));
    await store.setPaused(false, { type: "system" });
    const sent = await outcome(change({ kind: "send", person: ids.sam }));
    await change({ kind: "askAbout", person: ids.max, work: rota });
    const { people, teams } = await staff.onboardingStaff.organization();
    expect({
      paused,
      sent,
      sam: people.find(({ id }) => id === ids.sam)?.state,
      max: people.find(({ id }) => id === ids.max)?.work,
      rota: teams
        .find(({ id }) => id === ids.ops)
        ?.works.find(({ id }) => id === rota)?.doers,
    }).toStrictEqual({
      paused: "onboarding.not_now",
      sent: "ok",
      sam: "sent",
      max: rota,
      rota: [ids.lea, ids.max],
    });
  });

  it("refuses what it can't do: a name taken, another team's work, a map with nothing to draw from, someone not on the list", async () => {
    const ids = await running(1);
    const { tickets } = await mapOps(ids);
    const { change } = await asStaff();
    const refused = await Promise.all([
      outcome(change({ kind: "addTeam", name: " ops " })),
      outcome(change({ kind: "askAbout", person: ids.sam, work: tickets })),
      outcome(change({ kind: "draw", team: ids.sales })),
      outcome(change({ kind: "away", person: "nobody", away: true })),
      outcome(change({ kind: "lead", team: "nowhere", person: null })),
    ]);
    expect(refused).toStrictEqual([
      "onboarding.team_taken",
      "onboarding.no_work",
      "onboarding.no_map",
      "onboarding.not_found",
      "onboarding.no_team",
    ]);
  });
});
