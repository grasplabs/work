/**
 * `vp run seed`: fills the local stack `vp run dev` runs with the
 * prototype's demo company, Noordkade Finance (scripts/seed/company.ts),
 * so every page has something to show and shows what the prototype does:
 * the company's name, people in teams and roles, the onboarding's roster and plan, the
 * prototype's domains with the workflows core can run, 30 days of their
 * runs and apps over them (scripts/seed/screens.ts), Knowledge, and
 * chats. Run it while `vp run dev` runs.
 *
 * Everything goes through core's API as the person who would do it, signed
 * in through the local fake IdP; only what no API does is written into the
 * local state directly: people's full names and when they joined, the
 * runs' times (scripts/seed/runs.ts), when the onboarding's plan began,
 * and chat transcripts (scripts/seed/chats.ts).
 *
 * It only ever reaches localhost, and stops unless core there signs people
 * in through the fake IdP, which only a local stack does
 * (scripts/seed/local.ts). It can run again: it adds what is missing and
 * leaves the rest, and gives a domain runs only while it has none. To
 * start over, stop `vp run dev`, delete `apps/core/.wrangler/state`, and
 * start it again.
 */
import { appErrors } from "@grasp-os/shared/apps";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { onboardingErrors, planDays } from "@grasp-os/shared/onboarding";
import { organizationErrors } from "@grasp-os/shared/organization";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { z } from "zod";

import { engineFiles } from "./seed/apps.ts";
import { chats, writeTranscript } from "./seed/chats.ts";
import { companyName, people, roster, teamNames } from "./seed/company.ts";
import type { Person, PersonKey, TeamName } from "./seed/company.ts";
import { definitionText } from "./seed/definitions.ts";
import { decisionResponse, engines } from "./seed/engines.ts";
import type { EngineSeed, WorkflowSeed } from "./seed/engines.ts";
import { collections } from "./seed/knowledge.ts";
import type { CollectionSeed } from "./seed/knowledge.ts";
import {
  authCall,
  localD1,
  localObject,
  sessionOf,
  signInAs,
} from "./seed/local.ts";
import type { Session } from "./seed/local.ts";
import { seedRuns } from "./seed/runs.ts";
import { approvedScreens, engineScreens } from "./seed/screens.ts";

const dayMs = 24 * 60 * 60 * 1000;

/** Sign-ins at once: more keep the local core too busy (e2e/people.ts). */
const signInsAtOnce = 4;

const [admin] = people;

const core = localD1("workflow_resource_runs");

/** Runs `work` for each item, `limit` at a time, keeping their order. */
const mapLimited = async <T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += limit) {
    results.push(
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time
      ...(await Promise.all(items.slice(index, index + limit).map(work)))
    );
  }
  return results;
};

/** A team, as Better Auth's organization plugin returns it. */
const teamSchema = z.object({ id: z.string(), name: z.string() });

/**
 * The teams, each with its people (their user IDs by email), created
 * through Better Auth as an admin does.
 */
const seedTeams = async (
  adminSession: Session,
  userIds: ReadonlyMap<string, string>
): Promise<Map<TeamName, string>> => {
  const existing = z
    .array(teamSchema)
    .parse(await authCall(adminSession, "/organization/list-teams"));
  const ids = new Map<TeamName, string>();
  for (const name of teamNames) {
    const found = existing.find((team) => team.name === name);
    const team =
      found ??
      teamSchema.parse(
        // oxlint-disable-next-line no-await-in-loop -- one team at a time
        await authCall(adminSession, "/organization/create-team", { name })
      );
    ids.set(name, team.id);
  }
  const inTeam = core.prepare(
    "SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?"
  );
  for (const person of people satisfies readonly Person[]) {
    const userId = userIds.get(person.email) ?? "";
    for (const name of person.teams) {
      const teamId = ids.get(name);
      if (teamId !== undefined && inTeam.get(teamId, userId) === undefined) {
        // oxlint-disable-next-line no-await-in-loop -- one change at a time
        await authCall(adminSession, "/organization/add-team-member", {
          teamId,
          userId,
        });
      }
    }
  }
  return ids;
};

/**
 * Signs everyone in, which makes them members, then gives them their
 * names, roles, join dates and teams. Sessions open once all of that is
 * set, so each acts as who they are now.
 */
const seedPeople = async (): Promise<{
  sessions: Map<PersonKey, Session>;
  teams: Map<TeamName, string>;
}> => {
  // The admin first, the stack's configured admin anyway: signing in
  // refuses anything but a local stack, and nobody else signs in until
  // the stack is known to be this checkout's.
  const adminSession = await sessionOf(admin.email);
  let teams: Map<TeamName, string>;
  try {
    // The state this checkout's `vp run dev` keeps is the one that answers.
    if (
      core
        .prepare("SELECT 1 FROM users WHERE id = ?")
        .get(adminSession.userId) === undefined
    ) {
      throw new Error(
        "The core answering at localhost doesn't keep its state in this checkout: run the seed from the checkout `vp run dev` runs from."
      );
    }
    await mapLimited(people, signInsAtOnce, async ({ email }) => {
      await signInAs(email);
    });
    const members = await adminSession.api.members.list();
    for (const person of people satisfies readonly Person[]) {
      const member = members.find(({ email }) => email === person.email);
      if (member === undefined) {
        throw new Error(`${person.email} signed in but isn't a member`);
      }
      if (member.role !== person.role) {
        // oxlint-disable-next-line no-await-in-loop -- one change at a time
        await adminSession.api.members.setRole(member.userId, person.role);
      }
      // The fake IdP names people by their email's first word, and they
      // all joined just now.
      core
        .prepare("UPDATE users SET name = ? WHERE id = ?")
        .run(person.name, member.userId);
      core
        .prepare("UPDATE members SET created_at = ? WHERE user_id = ?")
        .run(Date.now() - person.joinedDaysAgo * dayMs, member.userId);
    }
    teams = await seedTeams(
      adminSession,
      new Map(members.map(({ email, userId }) => [email, userId]))
    );
  } finally {
    adminSession.close();
  }
  const sessions = await mapLimited(
    people,
    signInsAtOnce,
    async (person) => [person.key, await sessionOf(person.email)] as const
  );
  return { sessions: new Map(sessions), teams };
};

const sessionFor = (
  sessions: ReadonlyMap<PersonKey, Session>,
  key: PersonKey
): Session => {
  const session = sessions.get(key);
  if (session === undefined) {
    throw new Error(`Nobody signed in as ${key}`);
  }
  return session;
};

/** A collection, created by an admin, and its documents, written by its writer. */
const seedCollection = async (
  seed: CollectionSeed,
  sessions: ReadonlyMap<PersonKey, Session>,
  teams: ReadonlyMap<TeamName, string>
): Promise<string> => {
  const creator = sessionFor(sessions, seed.createdBy).api.knowledge;
  const { knowledge } = sessionFor(sessions, seed.writer).api;
  // Its writer reads it, whoever created it.
  const listed = await knowledge.listCollections();
  const collection =
    listed.find(({ name }) => name === seed.name) ??
    (await creator.createCollection({
      name: seed.name,
      description: seed.description,
      ...(seed.teams.length === 0
        ? { access: "everyone" }
        : {
            access: "teams",
            teams: seed.teams.flatMap((team) => teams.get(team) ?? []),
          }),
      sensitive: seed.sensitive ?? false,
    }));
  for (const document of seed.documents) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one save at a time
      await knowledge.saveDocument({
        collectionId: collection.id,
        path: document.path,
        text: document.text,
        ifVersion: 0,
      });
    } catch (error) {
      // It's there already: seeded before.
      if (knowledgeErrors.codeOf(error) === "knowledge.conflict") {
        continue;
      }
      throw error;
    }
    if (document.update !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one save at a time
      await knowledge.saveDocument({
        collectionId: collection.id,
        path: document.path,
        text: document.update.text,
        ifVersion: 1,
        message: document.update.message,
      });
    }
  }
  return collection.id;
};

/**
 * Checks, as an admin, that every screen of the App's current version
 * builds, and approves those not approved yet when `approve`, so its
 * people see their data in them. A screen left unapproved still has to
 * build: one that doesn't fails the seed, not the first person to open it.
 */
const reviewScreens = async (
  adminSession: Session,
  app: string,
  approve: boolean
): Promise<void> => {
  const review = await adminSession.api.screenTrust.review(app);
  const artifacts = builtArtifacts(review.screens);
  if (artifacts.length < review.screens.length) {
    throw new Error(`Not every screen of ${review.name} builds`);
  }
  if (!approve || review.screens.every(({ trust }) => trust === "approved")) {
    return;
  }
  await adminSession.api.screenTrust.approve(app, {
    version: review.version,
    generation: review.generation,
    artifacts,
  });
};

/**
 * Brings an engine seeded before it had its apps, or with older ones, to
 * the seed's screens, as its next version made current. Only the seed's
 * own change is made current: a later version that holds exactly the
 * current one plus the seed's screens (a seed stopped before making it
 * current) is reused; one with anyone else's changes is left alone, and
 * so is the engine, as committing over it would release them.
 */
const upgradeScreens = async (
  owner: Session,
  adminSession: Session,
  app: { id: string; name: string; currentVersion: number | null },
  screens: Readonly<Record<string, string>>
): Promise<void> => {
  const current = app.currentVersion ?? undefined;
  const files = await owner.api.apps.files.read(app.id, current);
  const changed = Object.fromEntries(
    Object.entries(screens).filter(([path, code]) => files[path] !== code)
  );
  if (Object.keys(changed).length === 0) {
    return;
  }
  const [latest] = await owner.api.apps.versions.list(app.id);
  if (latest !== undefined && latest.version !== current) {
    const later = await owner.api.apps.files.read(app.id, latest.version);
    const upgraded = { ...files, ...screens };
    const paths = new Set([...Object.keys(later), ...Object.keys(upgraded)]);
    if ([...paths].some((path) => later[path] !== upgraded[path])) {
      console.warn(
        `${app.name} has a version that isn't current, with changes of its own: its apps are left as they are.`
      );
      return;
    }
    await adminSession.api.apps.versions.setCurrent(app.id, latest.version);
    return;
  }
  const { version } = await owner.api.apps.files.commit(
    app.id,
    changed,
    "Add the engine's apps"
  );
  await adminSession.api.apps.versions.setCurrent(app.id, version);
};

/** A workflow's name in the organization, as an error says it is taken. */
const isTaken = (error: unknown): boolean =>
  workflowResourceErrors.codeOf(error) === "workflow.name_taken";

/**
 * An engine's workflow, as an independent workflow of its owner's: its
 * version 1 published from the seed's definition and modules; for one
 * that asks a decision, its decision contract published by an admin, its
 * binding approved for the team that answers it, and its person parameter
 * set to that team; shared with the engine's teams. Returns its ID.
 * Found by name when seeded before: left as it is once it has a version,
 * and set up from its publication on when a seed stopped before that.
 */
const seedWorkflow = async (
  workflow: WorkflowSeed,
  engine: EngineSeed,
  sessions: ReadonlyMap<PersonKey, Session>,
  teams: ReadonlyMap<TeamName, string>
): Promise<string> => {
  const adminSession = sessionFor(sessions, admin.key);
  const owner = sessionFor(sessions, workflow.owner ?? engine.owner);
  const resources = owner.api.workflowResources;
  const listed = await adminSession.api.workflowResources.list();
  const found = listed.find(({ name }) => name === workflow.id);
  const published =
    found === undefined ? [] : await resources.versions(found.id);
  if (found !== undefined && published.length > 0) {
    return found.id;
  }
  let created: { id: string; name: string };
  try {
    created = found ?? (await resources.create(workflow.id));
  } catch (error) {
    if (isTaken(error)) {
      throw new Error(
        `A workflow named ${workflow.id} is taken by one the seed can't see: start over to seed again.`,
        { cause: error }
      );
    }
    throw error;
  }
  const { decision } = workflow;
  if (decision !== undefined) {
    try {
      await adminSession.api.workflowResources.publishContract({
        key: decision.contract,
        kind: "decision",
        input: decision.input,
        response: decisionResponse,
      });
    } catch (error) {
      // Published for another workflow, or a seed before: the same one.
      if (workflowResourceErrors.codeOf(error) !== "workflow.contract_exists") {
        throw error;
      }
    }
  }
  await resources.publish(created.id, {
    definition: definitionText(created.name, workflow.title, workflow.parts),
    basedOn: null,
    modules: workflow.modules,
  });
  if (decision !== undefined) {
    const teamId = teams.get(decision.team);
    if (teamId === undefined) {
      throw new Error(`No team ${decision.team}`);
    }
    await adminSession.api.workflowResources.approveBinding(created.id, {
      alias: decision.binding,
      target: { kind: "decision", deciders: [`team:${teamId}`] },
      reviewed: { version: 1 },
    });
    const { revision } = await resources.params(created.id);
    await resources.setParams(created.id, {
      values: { [decision.param]: `team:${teamId}` },
      expectedRevision: revision,
    });
  }
  for (const { team, role } of engine.teams) {
    const id = teams.get(team);
    if (id !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one change at a time
      await resources.share(created.id, { type: "team", id, role });
    }
  }
  return created.id;
};

/** The binding name an App's permission to start `alias` goes by. */
const startBindingOf = (alias: string): string =>
  alias
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower>_$<upper>")
    .toUpperCase();

/**
 * The App's permission to start each of its workflows from its screens,
 * asked by the engine's owner and granted by an admin, where it has none;
 * one still requested (a seed stopped before granting it) is granted
 * now. One someone revoked is left revoked: that was their decision.
 */
const seedStartPermissions = async (
  engine: EngineSeed,
  app: string,
  workflowIds: ReadonlyMap<string, string>,
  sessions: ReadonlyMap<PersonKey, Session>
): Promise<void> => {
  const adminSession = sessionFor(sessions, admin.key);
  const held = await adminSession.api.permissions.list({
    type: "app",
    appId: app,
  });
  const { currentVersion } = await adminSession.api.apps.get(app);
  for (const { alias } of engine.workflows) {
    const workflowId = workflowIds.get(alias);
    const binding = startBindingOf(alias);
    const had = held.find(({ binding: name }) => name === binding);
    if (
      workflowId === undefined ||
      (had !== undefined && had.status !== "requested")
    ) {
      continue;
    }
    let id = had?.id;
    if (id === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const requested = await sessionFor(
        sessions,
        engine.owner
      ).api.permissions.request({
        subject: { type: "app", appId: app },
        object: { type: "workflow", workflowId },
        actions: ["start"],
        binding,
      });
      ({ id } = requested);
    }
    // oxlint-disable-next-line no-await-in-loop -- one grant at a time
    await adminSession.api.permissions.grant(id, { version: currentVersion });
  }
};

/**
 * An engine: created by its owner with its workflows and apps, its version
 * made current by an admin, its apps approved where the seed says so,
 * shared with its teams, its workflows' owners and deciders set, and,
 * while it has none, its runs. Returns its ID, and how many runs it got.
 */
const seedEngine = async (
  seed: EngineSeed,
  sessions: ReadonlyMap<PersonKey, Session>,
  teams: ReadonlyMap<TeamName, string>
): Promise<{ id: string; runs: number }> => {
  const adminSession = sessionFor(sessions, admin.key);
  const owner = sessionFor(sessions, seed.owner);
  const all = await adminSession.api.apps.list();
  const existing = all.find(({ name }) => name === seed.name);
  const app =
    existing ??
    (await owner.api.apps.create({
      name: seed.name,
      description: seed.description,
    }));
  // Someone archived it: it is read-only, and restoring it is their
  // decision. The seed leaves it as it is.
  if (app.status === "archived") {
    console.warn(`${app.name} is archived: the seed leaves it as it is.`);
    return { id: app.id, runs: 0 };
  }
  const screens = Object.fromEntries(
    Object.entries(engineScreens[seed.name] ?? {}).map(([name, code]) => [
      `screens/${name}.tsx`,
      code,
    ])
  );
  const workflowIds = new Map<string, string>();
  for (const workflow of seed.workflows) {
    workflowIds.set(
      workflow.alias,
      // oxlint-disable-next-line no-await-in-loop -- one workflow at a time
      await seedWorkflow(workflow, seed, sessions, teams)
    );
  }
  if (app.currentVersion === null) {
    for (const { alias } of seed.workflows) {
      const id = workflowIds.get(alias);
      if (id !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- one binding at a time
        await owner.api.workflowResources.bindToApp(id, {
          app: app.id,
          alias,
          version: 1,
        });
      }
    }
    const { version } = await owner.api.apps.files.commit(
      app.id,
      engineFiles(seed, screens),
      "Release the engine's workflows and apps"
    );
    // An admin makes it current, which approves its code, once its
    // workflow tests pass.
    await adminSession.api.apps.versions.setCurrent(app.id, version);
  } else if (Object.keys(screens).length > 0) {
    // Its screens need the engine's own App files and workflow bindings:
    // one seeded before them keeps the screens it has (nothing has
    // shipped, so no seed migrates it; reset local data to seed it anew).
    const files = await owner.api.apps.files.read(app.id, app.currentVersion);
    if (files["app.ts"] === engineFiles(seed, screens)["app.ts"]) {
      await upgradeScreens(owner, adminSession, app, screens);
    } else {
      console.warn(
        `${app.name} was seeded before its independent workflows: its screens are left as they are. Reset local data to seed it again.`
      );
    }
  }
  // Published, so the people it is shared with use it, once it has a
  // version current: only an App this run created. One it found is left
  // as someone left it, a draft they took it back to included.
  if (existing === undefined) {
    await adminSession.api.apps.publish(app.id);
  }
  if (Object.keys(screens).length > 0) {
    await reviewScreens(adminSession, app.id, approvedScreens.has(seed.name));
  }
  const shared = await owner.api.apps.members.list(app.id);
  for (const { team, role } of seed.teams) {
    const id = teams.get(team);
    if (
      id !== undefined &&
      !shared.some((member) => member.type === "team" && member.id === id)
    ) {
      // oxlint-disable-next-line no-await-in-loop -- one change at a time
      await owner.api.apps.members.add(app.id, { type: "team", id, role });
    }
  }
  await seedStartPermissions(seed, app.id, workflowIds, sessions);
  for (const id of workflowIds.values()) {
    // oxlint-disable-next-line no-await-in-loop -- one workflow at a time
    const ran = await owner.api.workflowResources.runs(id);
    if (ran.length > 0) {
      return { id: app.id, runs: 0 };
    }
  }
  const runs = await seedRuns({
    workflowIds,
    engine: seed.name,
    workflows: seed.workflows,
    sessions,
    db: core,
  });
  return { id: app.id, runs };
};

/**
 * Engines' access to Knowledge: one an admin granted, and one still
 * waiting for an admin, so the dashboard has a request to show.
 */
const seedPermissions = async (
  sessions: ReadonlyMap<PersonKey, Session>,
  engineIds: ReadonlyMap<string, string>,
  collectionIds: ReadonlyMap<string, string>
): Promise<void> => {
  const adminSession = sessionFor(sessions, admin.key);
  const wanted = [
    {
      engine: "Issue-to-Resolution",
      by: "lisa",
      collection: "Procedures",
      binding: "PROCEDURES",
      grant: true,
    },
    {
      engine: "Purchase-to-Pay",
      by: "eva",
      collection: "Finance",
      binding: "HANDBOOK",
      grant: false,
    },
  ] as const;
  for (const { engine, by, collection, binding, grant } of wanted) {
    const appId = engineIds.get(engine);
    const collectionId = collectionIds.get(collection);
    if (appId === undefined || collectionId === undefined) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one engine at a time
    const held = await adminSession.api.permissions.list({
      type: "app",
      appId,
    });
    if (held.some(({ binding: name }) => name === binding)) {
      continue;
    }
    const request: PermissionRequest = {
      subject: { type: "app", appId },
      object: { type: "collection", collectionId },
      actions: ["read"],
      binding,
    };
    // oxlint-disable-next-line no-await-in-loop -- one request at a time
    const { id } = await sessionFor(sessions, by).api.permissions.request(
      request
    );
    if (grant) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      const { currentVersion } = await adminSession.api.apps.get(appId);
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time
      await adminSession.api.permissions.grant(id, { version: currentVersion });
    }
  }
};

/**
 * How many whole weeks before this one the programme began: the
 * prototype's dashboard is in its fifth week of eight.
 */
const programmeWeeksAgo = 4;

/** The Monday (UTC) `weeks` before this week's, as `YYYY-MM-DD`. */
const mondayWeeksAgo = (weeks: number): string => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  return new Date(today.getTime() - (sinceMonday + weeks * 7) * dayMs)
    .toISOString()
    .slice(0, 10);
};

/**
 * The onboarding, as an admin sets it up: who works where, and the plan
 * for the interviews. Core plans them from today on, so a plan the seed
 * saves is then moved back in the Onboarding object's state, to the
 * programme's week the prototype shows. Without the agreements, which
 * only Grasp's staff record, no link opens or goes out. Returns whether
 * it set anything up.
 */
const seedOnboarding = async (adminSession: Session): Promise<boolean> => {
  const { onboarding } = adminSession.api;
  const view = await onboarding.view();
  if (view.roster === null) {
    await onboarding.saveRoster(roster());
  }
  if (view.plan !== null) {
    return view.roster === null;
  }
  const today = new Date().toISOString().slice(0, 10);
  await onboarding.savePlan({ start: today });
  // A plan is never moved once saved, a developer's own included, so a
  // move that fails says so rather than leaving week one unnoticed.
  try {
    const state = localObject("Onboarding", "onboarding", "1");
    try {
      state.prepare("UPDATE onboarding SET plan = ? WHERE id = 1").run(
        JSON.stringify({
          start: mondayWeeksAgo(programmeWeeksAgo),
          days: planDays.usual,
        })
      );
    } finally {
      state.close();
    }
  } catch (error) {
    throw new Error(
      `The onboarding's plan was saved from today, but couldn't be moved back to the programme's fifth week; start over to try again (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
  return true;
};

/**
 * Names the organization after the company, as its admin does in the
 * Workspace settings, while it has another name (core's default is
 * "Organization"). Returns whether it renamed it.
 */
const seedOrganization = async (adminSession: Session): Promise<boolean> => {
  const { organization } = adminSession.api;
  const { name } = await organization.get();
  if (name === companyName) {
    return false;
  }
  await organization.update({ name: companyName });
  return true;
};

/** The chats, each in its person's Workspace object. */
const seedChats = async (
  sessions: ReadonlyMap<PersonKey, Session>
): Promise<number> => {
  let created = 0;
  const now = Date.now();
  for (const chat of chats) {
    const { api } = sessionFor(sessions, chat.by);
    // oxlint-disable-next-line no-await-in-loop -- one chat at a time
    const listed = await api.chats.list();
    if (listed.some(({ title }) => title === chat.title)) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one chat at a time
    const { id } = await api.chats.create(chat.title);
    const workspace = localObject("Workspace", "chats", id);
    try {
      writeTranscript(workspace, id, chat, now);
    } finally {
      workspace.close();
    }
    created += 1;
  }
  return created;
};

const main = async (): Promise<void> => {
  console.info("Signing the demo company in…");
  const { sessions, teams } = await seedPeople();
  try {
    console.info(`${people.length} people in ${teams.size} teams`);

    const renamed = await seedOrganization(sessionFor(sessions, admin.key));
    console.info(
      renamed
        ? `The organization is named ${companyName}`
        : `The organization is ${companyName} already`
    );

    const planned = await seedOnboarding(sessionFor(sessions, admin.key));
    console.info(
      planned
        ? "The onboarding's roster and plan"
        : "The onboarding has its roster and plan already"
    );

    const collectionIds = new Map<string, string>();
    for (const seed of collections) {
      // oxlint-disable-next-line no-await-in-loop -- one collection at a time
      const id = await seedCollection(seed, sessions, teams);
      collectionIds.set(seed.name, id);
    }
    console.info(`${collections.length} Knowledge collections`);

    const engineIds = new Map<string, string>();
    for (const seed of engines) {
      // oxlint-disable-next-line no-await-in-loop -- one engine at a time
      const { id, runs } = await seedEngine(seed, sessions, teams);
      engineIds.set(seed.name, id);
      let ran = `${runs} runs over the last 30 days`;
      if (seed.workflows.length === 0) {
        ran = "no workflows yet";
      } else if (runs === 0) {
        ran = "has its runs already";
      }
      console.info(`Domain ${seed.name}: ${ran}`);
    }
    await seedPermissions(sessions, engineIds, collectionIds);

    const created = await seedChats(sessions);
    console.info(`${created} new chats`);
    console.info(
      `Done. Sign in at http://localhost:5173 as ${admin.email} (${admin.name}), or as any of its members (people in scripts/seed/company.ts).`
    );
  } finally {
    for (const session of sessions.values()) {
      session.close();
    }
    core.close();
  }
};

try {
  await main();
} catch (error) {
  // An App or Knowledge error says what core refused, in its own words.
  const coded =
    appErrors.codeOf(error) ??
    knowledgeErrors.codeOf(error) ??
    onboardingErrors.codeOf(error) ??
    organizationErrors.codeOf(error) ??
    workflowResourceErrors.codeOf(error);
  console.error(
    `The seed stopped${coded === undefined ? "" : ` (${coded})`}: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
}
