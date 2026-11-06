import { appErrors } from "@grasp-os/shared/apps";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { describe, expect, it, vi } from "vite-plus/test";

import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import type { ProviderReply } from "./model-provider.ts";
import { notesFiles } from "./notes-client-app.ts";
import { signedInApi } from "./sign-in.ts";

// `env.apps` in a chat's code: the chat's agent looking into its person's
// Apps, as them, with no permission of its own. These tests start from the
// ways it can fail: the agent reads past what its person may see (the code
// of an App they don't build); and a call leaves no trace.
// Already covered: the agent following an independent workflow's runs
// only once it may read it, never what a run returned
// (agent-workflow-build.test.ts, "lists and follows a workflow's runs only
// once it may read it, never what a run returned"). Gone with App
// workflows: `env.workflows.list`, `runs` and `status` of an App's own
// workflows and runs, read as part of the App, and where such a run
// failed.

const idp = mockIdp();

/**
 * A builder's App, current, and a chat of `person`'s (the builder, unless
 * another is given) answered by the replies `script` makes for its App,
 * and `grant`: every permission the agent could hold on it.
 */
const setUp = async (
  script: (app: string) => ProviderReply[],
  personRole?: "user"
) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const { id: app } = await builder.api.apps.create({ name: "Notes" });
  await release(builder, app, notesFiles);
  const person =
    personRole === undefined ? builder : await signedInApi(idp, personRole);
  const chat = await chatOf(person.userId, ...script(app));
  /** Grants the agent reading the Apps collection, and the App. */
  const grant = async () => {
    await requestGranted(
      idp,
      admin,
      readCollection(chat.agent, "apps", "APP_LIBRARY")
    );
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "app", appId: app },
      actions: ["read"],
      binding: "REPORT",
    });
  };
  return { app, chat, grant };
};

/** The `agent.call` events of the chat's agent, once there are `count`. */
const callsOf = async (agentId: string, count: number): Promise<AuditEvent[]> =>
  await vi.waitFor(
    async () => {
      const events = await allEvents();
      const calls = events.filter(
        ({ actor, action, detail }) =>
          action === "agent.call" &&
          // Not the catalog each turn reads for its skills.
          detail.turn !== true &&
          actor.type === "agent" &&
          actor.agentId === agentId
      );
      expect(calls).toHaveLength(count);
      return calls;
    },
    { timeout: 10_000, interval: 50 }
  );

/** Code that makes each call in turn: what it returned, or its message. */
const tryEach = (calls: Record<string, string>): string =>
  `export default async (self, env) => {
    const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
    const results = {};
    ${Object.entries(calls)
      .map(
        ([name, call]) =>
          `results[${JSON.stringify(name)}] = await tried(async () => ${call});`
      )
      .join("\n    ")}
    return results;
  };`;

/** Every call of the App, as the code makes them. */
const everyCall = (app: string) =>
  tryEach({
    apps: "(await env.apps.list()).map(({ id }) => id)",
    files: `Object.keys(await env.apps.files(${JSON.stringify(app)})).includes("grasp.config.ts")`,
    versions: `(await env.apps.versions(${JSON.stringify(app)})).map(({ version }) => version)`,
  });

describe("a chat's Apps", () => {
  it("show the agent its person's App, with no permission of its own, and record every call", async () => {
    const { app, chat } = await setUp((made) => [
      codeStep(everyCall(made)),
      says("Here it is."),
    ]);

    await chat.ask("What does the notes App do?");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(result?.text).toBe(
      `Returned:\n${JSON.stringify({ apps: [app], files: true, versions: [1] })}`
    );
    const calls = await callsOf(chat.agent.agentId, 3);
    expect(
      calls.map(({ detail }) => String(detail.method)).toSorted()
    ).toStrictEqual(["apps.files", "apps.list", "apps.versions"]);
  });

  it("read no further than the person may, with every permission granted", async () => {
    // Someone with no role in the App.
    const { chat, grant } = await setUp(
      (made) => [codeStep(everyCall(made)), says("Nothing of theirs.")],
      "user"
    );
    await grant();

    await chat.ask("What's there?");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const notFound = appErrors.create("app.not_found").message;
    expect(result?.text).toBe(
      `Returned:\n${JSON.stringify({
        apps: [],
        files: notFound,
        versions: notFound,
      })}`
    );
  });
});
