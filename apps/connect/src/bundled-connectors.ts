import { connectorManifestSchema } from "@grasp-os/runtime/connector";
import type { ConnectorManifest, SignIn } from "@grasp-os/runtime/connector";
import { log } from "@grasp-os/shared/log";

import bundled from "#connectors";

// The native connectors of this release, as build.ts bundled them, each
// checked again here: one whose manifest is broken is left out, and none
// of its tools runs. A tool that doesn't say whom it reaches breaks it: it
// has no class, so nothing could say whether a company allows it. An app's
// connector carries its provider record (runtime/connector's sign-in.ts),
// which is all connect knows of how to sign in to the app.

/** A connector of this release: its manifest and its bundled module. */
export interface NativeConnector {
  manifest: ConnectorManifest;
  code: string;
}

/** An app's provider record, and the connector that carries out its calls. */
export interface AppRecord {
  provider: string;
  server: string;
  signIn: SignIn;
}

/** The release's connectors by name. */
const connectors = new Map<string, NativeConnector>();
for (const { manifest, code } of bundled) {
  const parsed = connectorManifestSchema.safeParse(manifest);
  if (parsed.success) {
    connectors.set(parsed.data.name, { manifest: parsed.data, code });
  } else {
    log.error("connectors.invalid_manifest", {});
  }
}

/**
 * The apps' records by provider. Two connectors claiming one app, a record
 * either way, would leave it unclear whose record signs in and whose code
 * gets the token: no record does (build.ts refuses such a release; this is
 * in case one got through).
 */
const apps = new Map<string, AppRecord>();
const claims = Map.groupBy(
  [...connectors.values()].map(({ manifest }) => manifest),
  ({ provider }) => provider
);
for (const [provider, claimed] of claims) {
  const [manifest] = claimed;
  if (claimed.length === 1 && manifest?.signIn !== undefined) {
    apps.set(provider, {
      provider,
      server: manifest.name,
      signIn: manifest.signIn,
    });
  } else if (claimed.some(({ signIn }) => signIn !== undefined)) {
    log.error("connectors.duplicate_app", { provider });
  }
}

/** The connector named `name` in this release, if there is one. */
export const nativeConnector = (name: string): NativeConnector | undefined =>
  connectors.get(name);

/** Every connector of this release. */
export const nativeConnectors = (): readonly NativeConnector[] => [
  ...connectors.values(),
];

/** The record of the app `provider`, if this release has its connector. */
export const appRecord = (provider: string): AppRecord | undefined =>
  apps.get(provider);

/** Every app's record of this release. */
export const appRecords = (): readonly AppRecord[] => [...apps.values()];
