/**
 * The second half of provisioning's probe (spec 40.2 step 7): after core
 * answers its health check, the admin asks it, signed, whether it runs
 * as the client it was deployed for, the release it was deployed with on
 * the release's schema, whether each private binding the release gives
 * it and connect answers, and arms core's and connect's durable clocks
 * (core's src/provision-probe.ts). What it finds either checks out or
 * names the first thing that doesn't, as a code; the hostname stays
 * unpublished until it checks out.
 */
import "@tanstack/react-start/server-only";
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import { toHex } from "@grasp-os/shared/encoding";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import {
  connectVersionPath,
  connectVersionPurpose,
  provisionProbePath,
  provisionProbePurpose,
  provisionProbeSchema,
} from "@grasp-os/shared/provision-probe";
import type {
  ClockRegistration,
  ProvisionProbe,
} from "@grasp-os/shared/provision-probe";
import type { ReleaseManifest, WorkerEntry } from "@grasp-os/shared/release";
import { installMismatch } from "@grasp-os/shared/release-apply";
import { routerSecretHeader } from "@grasp-os/shared/router";
import { z } from "zod";

const encoder = new TextEncoder();

/** How the admin reaches a client's core for the probe. */
export interface ProbeRequest {
  origin: string;
  routerSecret: string;
  /** The client's core auth secret, the signing key's source. */
  authSecret: string;
  fetch: typeof fetch;
  /** How long the probe may take, its body included. */
  timeoutMs: number;
}

/**
 * What core at `origin` answers at `path` to a request the admin signs
 * with the key `purpose` derives from `authSecret` (the probe's request,
 * `sentAt` alone), checked against `schema`; undefined when it doesn't
 * answer, answers otherwise, or takes longer than `timeoutMs`.
 */
const askSigned = async <T>(
  {
    origin,
    routerSecret,
    authSecret,
    fetch: fetchCore,
    timeoutMs,
  }: ProbeRequest,
  {
    path,
    purpose,
    schema,
  }: { path: string; purpose: string; schema: z.ZodType<T> }
): Promise<T | undefined> => {
  const body = JSON.stringify({ sentAt: new Date().toISOString() });
  const key = await hkdfHmacKey(authSecret, purpose, ["sign"]);
  const signature = toHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))
  );
  const limit = deadline(timeoutMs);
  try {
    const answer = async (): Promise<unknown> => {
      const response = await fetchCore(`${origin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [routerSecretHeader]: routerSecret,
          [platformUpdateSignatureHeader]: signature,
        },
        body,
        redirect: "manual",
        signal: limit.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      return await response.json();
    };
    const parsed = schema.safeParse(
      await Promise.race([answer(), whenAborted(limit.signal)])
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    limit.clear();
  }
};

/**
 * What core at `origin` answers the admin's signed probe with;
 * undefined when it doesn't answer, answers anything but a probe (as a
 * core from before the probe does), or takes longer than `timeoutMs`.
 */
export const probeCore = async (
  request: ProbeRequest
): Promise<ProvisionProbe | undefined> =>
  await askSigned(request, {
    path: provisionProbePath,
    purpose: provisionProbePurpose,
    schema: provisionProbeSchema,
  });

const connectVersionSchema = z.object({
  ok: z.literal(true),
  version: z.string().min(1),
});

/**
 * The version core at `origin` names for its connect, to the admin's
 * signed request (@grasp-os/shared/provision-probe `connectVersionPath`);
 * undefined when it names none, doesn't answer, or takes longer than
 * `timeoutMs`.
 */
export const connectVersionOf = async (
  request: ProbeRequest
): Promise<string | undefined> => {
  const answered = await askSigned(request, {
    path: connectVersionPath,
    purpose: connectVersionPurpose,
    schema: connectVersionSchema,
  });
  return answered?.version;
};

/**
 * The binding kinds that are the client's own, which the probe asks: its
 * databases, buckets and Durable Object namespaces, the sandbox it runs
 * App code in (the Worker Loader), and connect, its other Worker.
 */
const privateBindingKinds: ReadonlySet<string> = new Set([
  "d1",
  "r2_bucket",
  "durable_object_namespace",
  "worker_loader",
  "service",
]);

const privateOf = (worker: WorkerEntry): string[] =>
  worker.bindings
    .filter(({ type }) => privateBindingKinds.has(type))
    .map(({ name }) => name);

/**
 * The private bindings of `core` and of `connect`, by name, connect's as
 * `connect.<name>`: each must answer the probe, core asking connect for
 * its own (core's src/provision-probe.ts).
 */
export const privateBindings = (
  core: WorkerEntry,
  connect: WorkerEntry
): string[] => [
  ...privateOf(core),
  ...privateOf(connect).map((name) => `connect.${name}`),
];

/** Why a probe's answer doesn't check out, as a code and identifiers. */
export interface ProbeFault {
  code:
    | "probe_identity_mismatch"
    | "probe_release_mismatch"
    | "probe_schema_mismatch"
    | "probe_binding_unanswered"
    | "probe_clock_unarmed"
    | "probe_starts_open";
  message: string;
}

/** Whether `clock` is armed and runs tasks. */
const isArmed = (clock: ClockRegistration | null): boolean =>
  clock !== null && clock.armed && clock.tasks.length > 0;

/**
 * Checks core's `answer` against what the admin deployed: client
 * `clientId` at version `version`, running release `release` on its
 * schema, or one the releases imported after it (`later`) took it ahead
 * to (`installMismatch`: what a core from before it doesn't say isn't
 * held against it), each of `bindings` answering, both clocks
 * armed with tasks to run and, where the company has to start closed
 * (`startsClosed`), a core that says it does: one from a release before
 * that starts open to all its people. Null when it checks out.
 */
export const probeFault = (
  answer: ProvisionProbe,
  {
    clientId,
    version,
    release,
    later,
    bindings,
    startsClosed,
  }: {
    clientId: string;
    version: string;
    release: ReleaseManifest;
    later: readonly ReleaseManifest[];
    bindings: readonly string[];
    startsClosed: boolean;
  }
): ProbeFault | null => {
  if (answer.clientId !== clientId || answer.version !== version) {
    return {
      code: "probe_identity_mismatch",
      message: `Core answered as ${answer.clientId ?? "no client"} at ${answer.version ?? "no version"}, not ${clientId} at ${version}`,
    };
  }
  const installed = installMismatch(release, "core", answer, later);
  if (installed?.reason === "release") {
    return {
      code: "probe_release_mismatch",
      message: `Core answered as release ${answer.release ?? "none"}, not ${release.releaseId}`,
    };
  }
  if (installed?.reason === "schema") {
    return {
      code: "probe_schema_mismatch",
      message: `Core's ${installed.binding} isn't at ${release.releaseId}'s last migration, nor one a later release takes it to`,
    };
  }
  const unanswered = bindings.filter((name) => answer.bindings[name] !== true);
  if (unanswered.length > 0) {
    return {
      code: "probe_binding_unanswered",
      message: `Core's ${unanswered.join(", ")} didn't answer`,
    };
  }
  const unarmed = (["core", "connect"] as const).filter(
    (name) => !isArmed(answer.clocks[name])
  );
  if (unarmed.length > 0) {
    return {
      code: "probe_clock_unarmed",
      message: `The ${unarmed.join(" and ")} clock isn't armed`,
    };
  }
  if (startsClosed && answer.startsClosed !== true) {
    return {
      code: "probe_starts_open",
      message: `Core doesn't start closed for ${clientId}'s onboarding`,
    };
  }
  return null;
};
