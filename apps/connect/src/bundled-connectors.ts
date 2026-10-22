import { connectorManifestSchema } from "@grasp-os/connector-kit/manifest";
import type { ConnectorManifest } from "@grasp-os/connector-kit/manifest";
import type { SignIn } from "@grasp-os/connector-kit/sign-in";
import { log } from "@grasp-os/shared/log";

import bundled from "#connectors";

// The native connectors of this release, as build.ts bundled them, each
// checked again here: one whose manifest is broken is left out. An app's
// connector carries its provider record (the connector kit's sign-in.ts),
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
 * The apps' records by provider. Two connectors claiming one app would
 * leave it unclear whose record signs in and whose code gets the token:
 * neither does (build.ts refuses such a release; this is in case one got
 * through).
 */
const apps = new Map<string, AppRecord>();
const claimed = new Set<string>();
for (const { manifest } of connectors.values()) {
  const { provider, signIn } = manifest;
  if (signIn !== undefined) {
    if (claimed.has(provider)) {
      apps.delete(provider);
      log.error("connectors.duplicate_app", { provider });
    } else {
      apps.set(provider, { provider, server: manifest.name, signIn });
    }
    claimed.add(provider);
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
