/**
 * The on-prem smoke run's sealed call (workerd-smoke.ts): on core served by
 * plain workerd, the local admin signs in through the fake IdP, creates an
 * App of spec 8's layout and makes it current, which seals it (its compile
 * on the sandbox host), and calls one of its public functions through
 * core's portable function route, as a portable host does. App code runs
 * only in a sealed release, and on-prem only as a session on the sandbox
 * supervisor, in a Worker Loader isolate of one of its workerd processes
 * (workerd-sandbox.ts). So the step holds that: the function's answer,
 * which only its code works out from its input, and the sessions the
 * supervisor was asked for, as the App and as the builder (a tap in front
 * of its socket, workerd-socket-tap.ts).
 */
import { readAppManifest, contractFingerprints } from "@grasp-os/sdk/host";
import { appTokenPath, portableFunctionPath } from "@grasp-os/shared/portable";
import { z } from "zod";

import { localAdmin } from "../apps/core/test/sign-in-config.ts";
import { cookieHeader, openSession } from "./core-session.ts";
import type { CoreSite } from "./core-session.ts";

/** The function the step calls, and what it is called with. */
const called = { path: "sums.twice", n: 20 } as const;

/** What only the App's code answers for `called.n`: twice it, plus one. */
const answer = called.n * 2 + 1;

/** The App: no tables, and one public query. */
const appFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "operations/sums.ts": `import { v } from "@grasp-os/sdk";
import { query } from "#grasp/server";

export const twice = query({
  args: { n: v.number().integer() },
  returns: v.number(),
  handler: async (_ctx, args) => args.n * 2 + 1,
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { twice } from "./operations/sums.ts";
import schema from "./schema.ts";

export default app({
  name: "Sums",
  schema,
  access: { tables: {} },
  operations: { sums: { twice } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
};

/** The builder's sessions' owner on the sandbox host (platform-sandbox.ts). */
const builderOwner = "platform:builder";

const tokenSchema = z.object({ token: z.string() });
const resultSchema = z.object({
  result: z.object({ ok: z.literal(true), value: z.unknown() }),
});

/** Why the step failed, with what core answered. */
const failed = async (step: string, response: Response): Promise<Error> =>
  new Error(`${step} answered ${response.status}: ${await response.text()}`);

/**
 * Seals an App on core at `site` and calls its function, then checks the
 * answer and that the supervisor ran it (`owners`, as the tap saw them).
 */
export const sealedCallOnWorkerd = async (
  site: CoreSite,
  owners: () => ReadonlySet<string>
): Promise<void> => {
  const admin = await openSession(site, localAdmin);
  try {
    const { id: app } = await admin.api.apps.create({ name: "Sums" });
    const { version } = await admin.api.apps.files.commit(
      app,
      appFiles,
      "Sums"
    );
    // Made current, the version is sealed: its release is what runs.
    await admin.api.apps.versions.setCurrent(app, version);
    // Its data is fine for code nobody approved: a portable host's call
    // runs no build core delivered (apps/core/src/app-function-route.ts).
    const { generation } = await admin.api.screenTrust.review(app);
    await admin.api.screenTrust.classify(app, "ordinary", generation);

    // The function's reference, as a developer's project generates it
    // from the App's sealed registration (scripts/package-definition-lib.ts).
    const definition = await admin.api.apps.definition(app);
    const manifest = readAppManifest(definition.app.manifest);
    const fingerprints = await contractFingerprints(manifest);
    const operation = manifest.operations[called.path];
    if (operation === undefined) {
      throw new Error(`The sealed App has no ${called.path}`);
    }

    const issued = await fetch(new URL(`${appTokenPath}/${app}`, site.origin), {
      method: "POST",
      headers: {
        ...site.headers,
        origin: site.origin,
        "content-type": "application/json",
        cookie: cookieHeader(admin.cookie),
      },
      body: "{}",
    });
    if (!issued.ok) {
      throw await failed("The App token request", issued);
    }
    const { token } = tokenSchema.parse(await issued.json());
    const response = await fetch(
      new URL(`${portableFunctionPath}/${app}`, site.origin),
      {
        method: "POST",
        headers: {
          ...site.headers,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reference: {
            resourceId: app,
            resourceVersion: version,
            contractId: called.path,
            fingerprint: fingerprints[called.path],
            kind: operation.kind,
          },
          input: { n: called.n },
        }),
      }
    );
    if (!response.ok) {
      throw await failed("The sealed function call", response);
    }
    const { value } = resultSchema.parse(await response.json()).result;
    if (value !== answer) {
      throw new Error(
        `The sealed function answered ${JSON.stringify(value)}, not ${answer}`
      );
    }
    const seen = owners();
    const missing = [app, builderOwner].filter((owner) => !seen.has(owner));
    if (missing.length > 0) {
      throw new Error(
        `The sandbox host ran no session as ${missing.join(" or ")} (it ran: ${[...seen].join(", ") || "none"})`
      );
    }
  } finally {
    admin.close();
  }
};
