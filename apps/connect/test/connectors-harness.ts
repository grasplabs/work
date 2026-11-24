import { connectorManifestSchema } from "@grasp-os/connector-kit/manifest";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import bundled from "#connectors";

import { connections } from "../src/db/schema.ts";
import type { EgressProps } from "../src/egress.ts";
import { connectApp, fakeApps } from "./app-provider.ts";
import type { AppName } from "./app-provider.ts";
import { connectAccount, ownAccount, someone } from "./connect.ts";
import type { Call } from "./connect.ts";
import { sampleHost } from "./fixtures/sample-connector.ts";
import { fakeProviders } from "./oauth-provider.ts";
import type { ProviderName } from "./oauth-provider.ts";
import { fakeSampleApi } from "./sample-api.ts";
import { callTool as call } from "./tool-calls.ts";

// What connectors*.test.ts and native-tools-*.test.ts share: the fake
// providers, apps and API the connectors reach, the connections they call
// through, and every native tool.

export const providers = fakeProviders();
export const apps = fakeApps();
export const api = fakeSampleApi();

/** A person's own Microsoft account, connected to `server`. */
export const connectionTo = async (
  server: string,
  provider: ProviderName = "microsoft",
  person: ConnectionPerson = someone()
): Promise<{ id: string; person: ConnectionPerson }> => {
  const id = await connectAccount(
    providers,
    person,
    ownAccount(person, provider)
  );
  await drizzle(env.DB)
    .update(connections)
    .set({ server })
    .where(eq(connections.id, id));
  return { id, person };
};

export const appNames: ReadonlySet<string> = new Set<AppName>([
  "sample-oauth",
  "sample-key",
]);
export const isApp = (provider: string): provider is AppName =>
  appNames.has(provider);

/**
 * A person's own account at `provider`, connected to `server`: through
 * the app's own sign-in for an app, whose connector is the one it names.
 */
export const connectionOf = async (
  server: string,
  provider: string
): Promise<{ id: string; person: ConnectionPerson }> => {
  if (!isApp(provider)) {
    return await connectionTo(
      server,
      provider === "google" ? "google" : "microsoft"
    );
  }
  const person = someone();
  const id = await connectApp(
    apps,
    person,
    apps.account(provider, person.email)
  );
  return { id, person };
};

/** What a probe reports about its attempt. */
export interface Attempt {
  status: number | null;
  bytes: number;
  error: string | null;
}

export const isAttempt = (value: unknown): value is Attempt =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  "bytes" in value &&
  "error" in value;

/** Has the sample connector's code send a request, and says how it went. */
export const probe = async (
  connection: { id: string; person: ConnectionPerson },
  input: {
    url: string;
    method?: string;
    headers?: [string, string][];
    mailbox?: string;
  },
  extra: Partial<Call> = {}
): Promise<Attempt> => {
  const tool = input.mailbox === undefined ? "probe.fetch" : "probe.mailbox";
  const { output } = await call(connection, tool, input, extra);
  const attempt: unknown = JSON.parse(output);
  if (!isAttempt(attempt)) {
    throw new TypeError("Not a probe's report");
  }
  return attempt;
};

/** A probe's report of a request the egress handler refused. */
export const refused = { status: 403, error: null };

/** Props for the egress handler, as connect sets them for one call. */
export const egressProps = (
  fields: Partial<EgressProps> = {}
): EgressProps => ({
  connector: "sample@1.0.0",
  callId: "call-1",
  hosts: [sampleHost],
  routes: [{ method: "GET", host: sampleHost, path: "/v1/probe/{case}" }],
  values: {},
  credential: { header: "authorization", value: "Bearer a-token-for-one-call" },
  expiresAt: Date.now() + 30_000,
  ...fields,
});

// The connector contract: a tool may select a resource by its one declared
// property only, and parses its input strictly, so no second selector, at
// the top or nested, gets past it. Connect sees only top-level keys; the
// connector refuses the rest itself, before anything goes out.
export const tools = bundled.flatMap(({ manifest }) => {
  const parsed = connectorManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    // `sample-unreached`, which connect refuses whole (above).
    return [];
  }
  const { name, provider, actions } = parsed.data;
  return Object.keys(actions).map((action) => ({
    connector: name,
    provider,
    action,
  }));
});
