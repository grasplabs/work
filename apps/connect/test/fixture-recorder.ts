/**
 * Records a connector's fixtures (GRA-2328) through connect's whole call
 * path: a connection holding a credential, each case of the connector's
 * `fixtures.json` called as a workflow calls it (policy, a fresh isolate,
 * the egress that adds the credential), and every request that leaves
 * connect captured where it leaves, with the vendor's answer. A live run
 * (fixtures.live.test.ts) lets them through to the vendor itself; its own
 * tests to a stand-in. What is kept is what `recordedFixtures` keeps:
 * nothing secret, nothing personal. Each call's output is then made by
 * calling the tool again, as before, with only what is kept as its vendor,
 * so it too holds only stand-ins.
 */
import {
  connectorManifestSchema,
  fixtureVendor,
  recordedFixtures,
} from "@grasp-os/runtime/connector";
import type {
  Captured,
  FixtureCall,
  FixtureCase,
  Fixtures,
  Seen,
} from "@grasp-os/runtime/connector";
import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { vi } from "vite-plus/test";
import { z } from "zod";

import bundled from "#connectors";

import { connectionTokens } from "../src/db/schema.ts";
import { agentFor, callAs, someone } from "./connect.ts";
import { smokeConnection } from "./smoke.ts";

/** How many pages a paged case may take before the recording stops. */
const maxRecordedPages = 10;

/**
 * `bytes` as text, refused when they aren't: a file's bytes would be
 * recorded mangled, and nothing could look inside them for what isn't kept.
 */
const textOf = (bytes: ArrayBuffer): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes
    );
  } catch {
    throw new Error(
      "A request or an answer isn't text, such as a file's bytes: it isn't recorded"
    );
  }
};

const outputSchema = z.record(z.string(), z.json());

/** The bundled connector named `name`'s manifest. */
const manifestOf = (name: string) => {
  const found = bundled.find(
    ({ manifest }) =>
      typeof manifest === "object" &&
      manifest !== null &&
      Reflect.get(manifest, "name") === name
  );
  if (found === undefined) {
    throw new Error(
      `No connector named ${name} is bundled for connect's tests`
    );
  }
  return connectorManifestSchema.parse(found.manifest);
};

type Case = Omit<Fixtures["cases"][number], "calls">;
type SeenCall = Seen["cases"][number]["calls"][number];
type Call = (args: Case["args"]) => Promise<{ output: string }>;

/**
 * Each call of `fixture`, through `call`: what it sent (the requests
 * `captured` gained meanwhile) and answered, page after page of a paged
 * case. A call that doesn't end as the case says stops the run.
 */
const recordCase = async (
  fixture: Case,
  captured: readonly Captured[],
  call: Call
): Promise<SeenCall[]> => {
  const { tool, cursor, error: failsAs } = fixture;
  const calls: SeenCall[] = [];
  let { args } = fixture;
  for (;;) {
    if (calls.length === maxRecordedPages) {
      throw new Error(
        `${tool} still pages after ${maxRecordedPages} pages: record it with arguments that list less`
      );
    }
    const from = captured.length;
    let next: unknown;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each page needs the one before
      const answered = await call(args);
      ({ next } = outputSchema.parse(JSON.parse(answered.output)));
    } catch (error) {
      if (failsAs === undefined) {
        throw new Error(`${tool} failed, and its case names no error`, {
          cause: error,
        });
      }
      if (captured.length === from) {
        throw new Error(
          `${tool} failed before it reached the vendor: its case records how the vendor's answer maps, so call it with arguments it takes`,
          { cause: error }
        );
      }
      calls.push({ exchanges: captured.slice(from) });
      return calls;
    }
    calls.push({ exchanges: captured.slice(from) });
    if (cursor === undefined || typeof next !== "string") {
      break;
    }
    args = { ...fixture.args, [cursor]: next };
  }
  if (failsAs !== undefined) {
    throw new Error(`${tool} succeeded, and its case is an error case`);
  }
  if (cursor !== undefined && calls.length === 1) {
    throw new Error(
      `${tool} answered one page: record it with arguments that list more than a page`
    );
  }
  return calls;
};

/**
 * `fixture`'s calls with each one's output, as `call` answers with only
 * what is kept of the call as its vendor (through `answerWith`), the
 * next page asked for with the `next` the page before answered. The last
 * call of an error case answers none.
 */
const withOutputs = async (
  fixture: FixtureCase,
  answerWith: (vendor: (request: Request) => Promise<Response>) => void,
  call: Call
): Promise<FixtureCall[]> => {
  const { tool, cursor, error: failsAs, calls } = fixture;
  const withOutput: FixtureCall[] = [];
  let { args } = fixture;
  for (const [index, { exchanges }] of calls.entries()) {
    if (failsAs !== undefined && index === calls.length - 1) {
      withOutput.push({ exchanges });
      break;
    }
    const kept = fixtureVendor(exchanges);
    answerWith(
      async (request) =>
        (await kept.answer(request)) ??
        new Response("Not recorded", { status: 501 })
    );
    let output: z.infer<typeof outputSchema>;
    try {
      // oxlint-disable-next-line no-await-in-loop -- each page needs the one before
      const answered = await call(args);
      output = outputSchema.parse(JSON.parse(answered.output));
    } catch (error) {
      throw new Error(
        `${tool} doesn't answer from what is kept of its recording, call ${index + 1}`,
        { cause: error }
      );
    }
    withOutput.push({ exchanges, output });
    if (cursor !== undefined && typeof output.next === "string") {
      args = { ...fixture.args, [cursor]: output.next };
    }
  }
  return withOutput;
};

/**
 * The fixtures of connector `name`, recorded with `credential` (its API
 * key, or an access token taken as is) for each case `plan` lists, its
 * personal fields as `plan` names them, against `vendor`: where every
 * request that leaves connect goes. Only tools that only read are
 * recorded, so a recording run changes nothing at the vendor. A call that
 * doesn't end as its case says (one that fails where no error is named,
 * or an error case that succeeds) stops the run with why.
 */
export const recordFixtures = async (
  name: string,
  credential: string,
  plan: Fixtures,
  vendor: (request: Request) => Response | Promise<Response>
): Promise<Fixtures> => {
  const manifest = manifestOf(name);
  for (const { tool } of plan.cases) {
    if (manifest.actions[tool]?.readOnly !== true) {
      throw new Error(
        `${name}'s ${tool} isn't a tool that only reads: it isn't recorded`
      );
    }
  }
  const captured: Captured[] = [];
  // The vendor itself while recording; what is kept of it while outputs
  // are made, when nothing more is captured.
  let answering: ((request: Request) => Promise<Response>) | undefined;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (answering !== undefined) {
        return await answering(request);
      }
      const body = textOf(await request.clone().arrayBuffer());
      const response = await vendor(request);
      captured.push({
        method: request.method,
        url: request.url,
        body,
        status: response.status,
        headers: Object.fromEntries(response.headers),
        answer: textOf(await response.clone().arrayBuffer()),
      });
      return response;
    });
  try {
    const person = someone("admin");
    const { signIn } = manifest;
    // A key is connected as a person connects one, so whose account it is
    // is recorded too; a token is taken as is.
    let connectionId: string;
    let onBehalfOf: string = person.userId;
    let account: Captured | undefined;
    if (signIn?.kind === "api_key") {
      ({ connectionId } = await exports.default.connectWithKey({
        person,
        provider: name,
        scope: "shared",
        key: credential,
      }));
      const lookup = new URL(signIn.account.url).href;
      account = captured.find(({ url }) => new URL(url).href === lookup);
    } else {
      connectionId = await smokeConnection(manifest.provider, name, credential);
      onBehalfOf = "user-smoke";
    }
    /**
     * Calls `fixture`'s tool as a workflow does, on a connection a rate
     * limit recorded before, or replayed, hasn't paused.
     */
    const callOf =
      (fixture: Case): Call =>
      async (args) => {
        await drizzle(env.DB)
          .update(connectionTokens)
          .set({ pausedUntil: null })
          .where(eq(connectionTokens.connectionId, connectionId));
        const resource = manifest.actions[fixture.tool]?.resource;
        const named =
          resource === null || resource === undefined
            ? undefined
            : fixture.args[resource];
        return await callAs(agentFor(onBehalfOf), {
          connectionId,
          action: fixture.tool,
          input: args,
          ...(typeof named === "string" ? { resource: named } : {}),
        });
      };
    const cases: Seen["cases"][number][] = [];
    for (const { calls: _calls, ...fixture } of plan.cases) {
      // oxlint-disable-next-line no-await-in-loop -- one case at a time, so each one's requests are its own
      const calls = await recordCase(fixture, captured, callOf(fixture));
      cases.push({ ...fixture, calls });
    }
    // Egress follows a download's redirect to a signed URL off the
    // connector's hosts: that URL is a secret no rule knows of.
    if (
      captured.some(
        ({ url }) => !manifest.hosts.includes(new URL(url).hostname)
      )
    ) {
      throw new Error(
        `${name} sent a request off its hosts, such as to a download's signed URL: it isn't recorded`
      );
    }
    const { fixtures: kept, refuseKnownIn } = recordedFixtures(
      { ...(account === undefined ? {} : { account }), cases },
      { credential, personal: plan.personal, secret: plan.secret ?? [] }
    );
    const answerWith = (answer: (request: Request) => Promise<Response>) => {
      answering = answer;
    };
    const withOutput: FixtureCase[] = [];
    for (const fixture of kept.cases) {
      withOutput.push({
        ...fixture,
        // oxlint-disable-next-line no-await-in-loop -- one case at a time, each with its own vendor
        calls: await withOutputs(fixture, answerWith, callOf(fixture)),
      });
    }
    refuseKnownIn(
      withOutput.flatMap(({ calls }) => calls.map(({ output }) => output))
    );
    return { ...kept, cases: withOutput };
  } finally {
    spy.mockRestore();
  }
};
