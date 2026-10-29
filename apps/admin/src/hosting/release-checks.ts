/**
 * What a release shows of a hosting policy's requirements by itself,
 * read from its manifest as the admin imported it (stored whole, with
 * its SHA-256, and never changed): the manifest carries each Worker's
 * observability settings and how core reaches models, so whether its
 * logs hold no payloads and its model transport is approved is a fact
 * of the release, not of where it runs. Derived on read rather than
 * stored: the manifest is the record.
 *
 * - `logs.payload_free`: core and connect both turn invocation logs off
 *   (`observability.logs.invocation_logs: false`), the logs that would
 *   hold each request's URL and headers. Everything else core and
 *   connect log is metadata only (@grasp-os/shared/log).
 * - `models.approved_transport`: core reaches models only through the
 *   deployment's AI Gateway, with payload logging and caching off, as
 *   the release build reads it from the headers core sends
 *   (@grasp-os/shared/model-transport).
 *
 * Provisioning refuses a release that doesn't show what the client's
 * policy requires (src/hosting/operation.ts), and in this admin's own
 * destination records what it read as the destination's evidence.
 */
import type { ReleaseManifest } from "@grasp-os/shared/release";

import type { Capability } from "./policy.ts";

/** The capabilities a release shows by itself. */
export const releaseCheckedCapabilities = [
  "logs.payload_free",
  "models.approved_transport",
] as const satisfies readonly Capability[];

export type ReleaseCheckedCapability =
  (typeof releaseCheckedCapabilities)[number];

/** What a release shows of one capability, and how that was read. */
export interface ReleaseFinding {
  capability: ReleaseCheckedCapability;
  holds: boolean;
  /** What was read, in words, for the evidence. */
  procedure: string;
}

/** The Workers whose logs must hold no payloads. */
const loggedWorkers = ["core", "connect"] as const;

/** What `manifest` shows of each capability a release shows by itself. */
export const releaseFindings = (
  manifest: ReleaseManifest
): ReleaseFinding[] => {
  const logged = loggedWorkers.filter(
    (app) =>
      manifest.workers[app]?.observability.logs?.invocation_logs !== false
  );
  const transport = manifest.modelTransport;
  return [
    {
      capability: "logs.payload_free",
      holds: logged.length === 0,
      procedure:
        logged.length === 0
          ? `Read from release ${manifest.releaseId}'s manifest: core and connect both turn invocation logs off (observability.logs.invocation_logs is false).`
          : `Read from release ${manifest.releaseId}'s manifest: ${logged.join(" and ")} doesn't turn invocation logs off.`,
    },
    {
      capability: "models.approved_transport",
      holds:
        transport?.via === "ai_gateway" &&
        !transport.payloadLogging &&
        !transport.cache,
      procedure:
        transport === undefined
          ? `Read from release ${manifest.releaseId}'s manifest: it declares no model transport.`
          : `Read from release ${manifest.releaseId}'s manifest: core reaches models through ${transport.via === "ai_gateway" ? "AI Gateway" : transport.via}, payload logging ${transport.payloadLogging ? "on" : "off"}, caching ${transport.cache ? "on" : "off"}, as the build read it from the headers core sends.`,
    },
  ];
};
