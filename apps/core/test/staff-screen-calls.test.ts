import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { builtArtifacts } from "@grasp-os/shared/screen-trust";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { loadRelease } from "../src/app-releases.ts";
import { approveResourceBinding } from "../src/resource-bindings.ts";
import { published } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { person } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  openRpc,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  whoami,
} from "./sign-in.ts";

// A Grasp staff session's screen of an App (GRA-1088): what the App does
// for them, the Apps it calls on down the chain included, is theirs in the
// client's audit log, "(Grasp staff)", for a screen's plain call and for
// an action it sends under a key alike. Their access, not the mark,
// decides what goes ahead.

const idp = mockIdp();

/** Signing people in and sealing Apps can be slow on CI. */
const setUpTime = { timeout: 120_000 };

/** A relay: `relay.go` calls the App bound as `next`, and says how far it got. */
const relayFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "operations/relay.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const next = resource.app("next", {
  functions: { "relay.go": { kind: "action", args: {}, returns: v.string() } },
});

export const go = action({
  args: {},
  returns: v.string(),
  uses: [next],
  handler: async (ctx) => {
    try {
      return "+" + (await ctx.resources.next.call("relay.go", {}));
    } catch (error) {
      return "+error:" + String(Reflect.get(Object(error), "code"));
    }
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { go, next } from "./operations/relay.ts";
import schema from "./schema.ts";

export default app({
  name: "Relay",
  schema,
  access: { tables: {} },
  operations: { relay: { go } },
  internalOperations: {},
  screens: [],
  uses: [next],
});
`,
  "screens/relay.tsx": `export default function Relay() {
  return <p>Relay</p>;
}
`,
};

/** A builder's relay, current and published, its screen's build approved. */
const relay = async (name: string) => {
  const builder = await signedInApi(idp, "builder");
  const admin = await signedInApi(idp, "admin");
  const { id } = await builder.api.apps.create({ name });
  await published(id);
  const { version } = await builder.api.apps.files.commit(
    id,
    relayFiles,
    "First"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  const review = await admin.api.screenTrust.review(id);
  await admin.api.screenTrust.approve(id, {
    version: review.version,
    generation: review.generation,
    artifacts: builtArtifacts(review.screens),
  });
  return { app: id, version, release: await loadRelease(env, id, version) };
};

/** The relay's `relay.go`, as its screen sends it, under `key` if given. */
const goRequest = (
  { release }: Awaited<ReturnType<typeof relay>>,
  key?: string
): string =>
  JSON.stringify({
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: "relay.go",
      fingerprint: release.fingerprints["relay.go"],
      kind: "action",
    },
    input: {},
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });

/** Posts `body` to `app`'s function path as `as`'s screen, under `lease`. */
const post = async (
  app: string,
  body: string,
  as: { session: string; userId: string },
  lease: string
): Promise<Response> =>
  await routed(`${appFunctionPath}/${app}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: as.session,
      [screenPersonHeader]: as.userId,
      [screenLeaseHeader]: lease,
    },
    body,
  });

/** Who each `app.call` to `callee` was made by, and for whom. */
const callsTo = (events: readonly AuditEvent[], callee: string) =>
  events
    .filter(
      ({ action, target }) => action === "app.call" && target?.id === callee
    )
    .map(({ actor, detail }) => ({
      staff: "staff" in actor ? actor.staff : undefined,
      onBehalfOf: detail.onBehalfOf,
    }));

describe("a Grasp staff session's screen of an App", setUpTime, () => {
  it("calls on down the chain as them, for a plain call and a keyed action alike", async () => {
    const admin = await person("admin");
    const [first, second] = await Promise.all([
      relay("First"),
      relay("Second"),
    ]);
    await approveResourceBinding(env, admin, {
      app: first.app,
      alias: "next",
      target: { kind: "app", appId: appIdSchema.parse(second.app) },
      reviewed: { version: first.version },
    });
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { userId } = await whoami(session);
    const { core } = await openRpc(session);
    const { lease } = await core
      .authenticate()
      .screens.open(first.app, "relay");
    const staff = { session, userId };

    const plain = await post(first.app, goRequest(first), staff, lease);
    const plainCalls = callsTo(await allEvents(), second.app);
    const keyed = await post(
      first.app,
      goRequest(first, crypto.randomUUID()),
      staff,
      lease
    );
    const allCalls = callsTo(await allEvents(), second.app);

    expect({
      answered: [plain.status, keyed.status],
      // The plain call's, then the keyed action's: each the staff member's.
      plain: plainCalls,
      keyed: allCalls.slice(plainCalls.length),
    }).toStrictEqual({
      answered: [200, 200],
      plain: [{ staff: userId, onBehalfOf: userId }],
      keyed: [{ staff: userId, onBehalfOf: userId }],
    });
  });
});
