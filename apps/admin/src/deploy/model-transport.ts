/**
 * How a client's core reaches its models (`MODEL_TRANSPORT`, the shared
 * package's model-transport.ts), as every deploy sets it: the client's
 * own setting, else the platform's default for its residency (Platform's
 * AI page), else the built-in one (AI Gateway; for an EU organization,
 * Claude in Amazon Bedrock in Frankfurt). Its residency always follows
 * the organization's jurisdiction (`clientModelResidency`): a setting
 * may be stricter, never looser. And the provider keys that transport names, the only
 * entries of Secrets Store's `MODEL_PROVIDER_KEYS` its core is given:
 * another client's key never reaches it.
 */
import {
  defaultGatewayModels,
  modelGatewayConfigSchema,
} from "@grasp-os/shared/deployment-config";
import {
  defaultModelTransport,
  euGatewayModels,
  euModelTransport,
  maxFailoverTransports,
  modelTransportConfigSchema,
  modelTransportSchema,
  providerKeysNamed,
} from "@grasp-os/shared/model-transport";
import type {
  ModelProviderKeys,
  ModelResidency,
  ModelTransport,
  ModelTransportConfig,
  ResidencyAttestation,
} from "@grasp-os/shared/model-transport";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { AdminDatabase } from "../db/act.ts";
import { clientPlacements, platformSettings, settings } from "../db/schema.ts";
import {
  hostingPolicies,
  hostingPolicyIds,
  hostingPolicyIdSchema,
} from "../hosting/policy.ts";
import type { Jurisdiction } from "../hosting/policy.ts";

/** The Worker secret core reads its provider keys from, as JSON by name. */
export const providerKeysSecret = "MODEL_PROVIDER_KEYS";

/**
 * A platform default: the transport, and where it fails over to (off
 * unless staff set it). Its residency is each client's jurisdiction's, and it
 * names no private host: those are on-prem only.
 */
export const platformTransportSchema = z.strictObject({
  primary: modelTransportSchema,
  failover: z
    .array(modelTransportSchema)
    .max(maxFailoverTransports)
    .default([]),
});
export type PlatformTransport = z.output<typeof platformTransportSchema>;

/** The `platform_settings` key of the default for `residency`. */
export const platformTransportKey = (residency: ModelResidency): string =>
  `model_transport.${residency}`;

/** JSON `value`, or undefined when it isn't JSON. */
const jsonOf = (value: string | undefined): unknown => {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/**
 * The platform's default transport for `residency`, as staff set it;
 * null while they set none, or the row doesn't parse (then the built-in
 * default holds, as it would with none).
 */
export const platformModelTransport = async (
  db: AdminDatabase,
  residency: ModelResidency
): Promise<PlatformTransport | null> => {
  const row = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, platformTransportKey(residency)))
    .get();
  const parsed = platformTransportSchema.safeParse(jsonOf(row?.value));
  return parsed.success ? parsed.data : null;
};

/**
 * Where the model calls of an organization in `jurisdiction` may be
 * processed: only in the EU for an EU organization, anywhere for one
 * without a jurisdiction.
 */
export const modelResidencyOf = (
  jurisdiction: Jurisdiction | null
): ModelResidency => (jurisdiction === "eu" ? "eu" : "global");

/**
 * Client `clientId`'s jurisdiction: its placement's policy's storage
 * jurisdiction, or the first policy's while it isn't placed, as it will
 * be placed under that one unless staff choose another. The one place
 * the admin reads it from for its models.
 */
export const clientJurisdiction = async (
  db: AdminDatabase,
  clientId: string
): Promise<Jurisdiction | null> => {
  const placement = await db
    .select({ policyId: clientPlacements.policyId })
    .from(clientPlacements)
    .where(eq(clientPlacements.clientId, clientId))
    .get();
  const parsed = hostingPolicyIdSchema.safeParse(placement?.policyId);
  const [first] = hostingPolicyIds;
  return hostingPolicies[parsed.success ? parsed.data : first]
    .storageJurisdiction;
};

/** Where client `clientId`'s model calls may be processed: its jurisdiction's residency. */
export const clientModelResidency = async (
  db: AdminDatabase,
  clientId: string
): Promise<ModelResidency> =>
  modelResidencyOf(await clientJurisdiction(db, clientId));

/** Where a client's transport comes from. */
export type TransportSource = "setting" | "platform" | "built_in";

/** A client's transport as a deploy sets it, and where it comes from. */
export interface EffectiveTransport {
  config: ModelTransportConfig;
  source: TransportSource;
}

/**
 * The transport a client whose jurisdiction needs `residency` runs with:
 * its `setting` (already parsed), else `platformDefault`, else the
 * built-in one for its residency. `residency` is forced to its
 * jurisdiction's, unless the setting is stricter (`eu` for an
 * organization without a jurisdiction), and
 * no private host goes out: a hosted client has none.
 */
export const effectiveModelTransport = ({
  residency,
  setting,
  platformDefault,
}: {
  residency: ModelResidency;
  setting: ModelTransportConfig | null;
  platformDefault: PlatformTransport | null;
}): EffectiveTransport => {
  const builtIn = residency === "eu" ? euModelTransport : defaultModelTransport;
  let source: TransportSource = "built_in";
  let chosen: Pick<ModelTransportConfig, "primary" | "failover" | "residency"> =
    builtIn;
  if (setting !== null) {
    source = "setting";
    chosen = setting;
  } else if (platformDefault !== null) {
    source = "platform";
    chosen = { ...platformDefault, residency };
  }
  return {
    source,
    config: {
      primary: chosen.primary,
      failover: chosen.failover,
      residency: residency === "eu" ? "eu" : chosen.residency,
      privateHosts: [],
    },
  };
};

/**
 * `MODEL_GATEWAY` for an EU organization that has no setting of its own:
 * Claude in Bedrock's EU inference profile, the only models its built-in
 * transport reaches, each role on one, and every call held to the EU.
 * Workers AI's defaults aren't pinned to the EU.
 */
const euGateway = (derived: unknown): Record<string, unknown> => ({
  ...(typeof derived === "object" && derived !== null ? derived : {}),
  models: [...euGatewayModels],
  roles: {
    quick: "bedrock-eu/claude-haiku-5-5",
    careful: "bedrock-eu/claude-sonnet-5-5",
  },
  eu: { models: [...euGatewayModels], deployment: true },
});

/**
 * `vars` with `MODEL_TRANSPORT` as `effectiveModelTransport` makes it
 * from the setting in `vars` (if any), and, for an EU organization whose
 * `MODEL_GATEWAY` is the derived one (`gatewaySet` false), its EU models.
 * A setting that doesn't parse is left as it is, for the deploy's check
 * to refuse (`checkDeployedConfig`).
 */
export const withModelTransport = (
  vars: Readonly<Record<string, unknown>>,
  {
    residency,
    platformDefault,
    gatewaySet,
  }: {
    residency: ModelResidency;
    platformDefault: PlatformTransport | null;
    gatewaySet: boolean;
  }
): Record<string, unknown> => {
  const set = vars.MODEL_TRANSPORT;
  const setting =
    set === undefined ? null : modelTransportConfigSchema.safeParse(set);
  if (setting !== null && !setting.success) {
    return { ...vars };
  }
  const { config } = effectiveModelTransport({
    residency,
    setting: setting?.data ?? null,
    platformDefault,
  });
  return {
    ...vars,
    MODEL_TRANSPORT: config,
    ...(residency === "eu" && !gatewaySet
      ? { MODEL_GATEWAY: euGateway(vars.MODEL_GATEWAY) }
      : {}),
  };
};

/**
 * The secrets core gets for its provider keys: `MODEL_PROVIDER_KEYS`,
 * JSON of only the entries of `keys` (Secrets Store's) that `transport`
 * (core's `MODEL_TRANSPORT`) names, in name order so the same keys make
 * the same secret; none when it names none the store has. A key it names
 * that the store lacks is left out: core refuses calls that need it, and
 * says which (Setup shows it).
 */
export const clientProviderKeys = (
  transport: unknown,
  keys: Readonly<ModelProviderKeys>
): Map<string, string> => {
  const parsed = modelTransportConfigSchema.safeParse(transport);
  if (!parsed.success) {
    return new Map();
  }
  const named = providerKeysNamed(parsed.data)
    .filter((name) => Object.hasOwn(keys, name))
    .toSorted();
  if (named.length === 0) {
    return new Map();
  }
  return new Map([
    [
      providerKeysSecret,
      JSON.stringify(
        Object.fromEntries(named.map((name) => [name, keys[name]]))
      ),
    ],
  ]);
};

/** A client's model setup as the admin derives it, for its Setup. */
export interface ClientTransportConfig {
  /** Its jurisdiction's residency. */
  residency: ModelResidency;
  /** Its own `MODEL_TRANSPORT` setting; null without one, or one that doesn't parse. */
  setting: ModelTransportConfig | null;
  effective: EffectiveTransport;
  /** The models its gateway allows, as its next deploy sets them. */
  models: string[];
}

/** Client `clientId`'s `key` setting, as JSON; undefined without one. */
const settingOf = async (
  db: AdminDatabase,
  clientId: string,
  key: string
): Promise<unknown> => {
  const row = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.clientId, clientId), eq(settings.key, key)))
    .get();
  return jsonOf(row?.value);
};

/**
 * Client `clientId`'s transport and models as its next deploy sets them,
 * read from the admin's records: what Setup shows when its core can't be
 * asked.
 */
export const clientTransportConfig = async (
  db: AdminDatabase,
  clientId: string
): Promise<ClientTransportConfig> => {
  const residency = await clientModelResidency(db, clientId);
  const setting = modelTransportConfigSchema.safeParse(
    await settingOf(db, clientId, "MODEL_TRANSPORT")
  );
  const gateway = modelGatewayConfigSchema(z.string()).safeParse(
    await settingOf(db, clientId, "MODEL_GATEWAY")
  );
  let models: string[] = [...defaultGatewayModels];
  if (gateway.success) {
    ({ models } = gateway.data);
  } else if (residency === "eu") {
    models = [...euGatewayModels];
  }
  return {
    residency,
    setting: setting.success ? setting.data : null,
    effective: effectiveModelTransport({
      residency,
      setting: setting.success ? setting.data : null,
      platformDefault: await platformModelTransport(db, residency),
    }),
    models,
  };
};

/** One transport in words for the audit log: its kind and names, never a key. */
const transportName = (transport: ModelTransport): string => {
  if (transport.kind === "direct") {
    const providers = (["anthropic", "openai", "bedrock-eu"] as const).filter(
      (provider) => transport[provider] !== undefined
    );
    return `direct:${providers.join("+")}`;
  }
  if (transport.kind === "openai-compatible") {
    return `openai-compatible:${transport.name}`;
  }
  return transport.kind;
};

/**
 * A transport and its failover as the audit log records it: kinds and
 * names, the failover after `>`, its residency when it is one; `default`
 * for none set.
 */
export const transportSummary = (
  config: Pick<ModelTransportConfig, "primary" | "failover"> &
    Partial<Pick<ModelTransportConfig, "residency">>
): string =>
  [
    [config.primary, ...config.failover].map(transportName).join(" > "),
    config.residency === undefined ? "" : ` (${config.residency})`,
  ].join("");

/** Who saves a transport, and when: what an attestation they give records. */
interface Attester {
  email: string;
  now: Date;
}

/** Why `stampAttestations` refused: an attestation made as someone else. */
export class AttestationError extends Error {
  constructor() {
    super("An attestation can only be made as the staff member saving it");
    this.name = "AttestationError";
  }
}

/**
 * `input`'s transports with each custom endpoint's EU attestation as the
 * one saving it gives it: one already in `kept` (attestations saved
 * before, as JSON) stays as it is; any other is stamped with `by` the
 * one saving it and `at` now, whatever the page sent, and refused
 * (`AttestationError`) when it names someone else. Only the basis comes
 * from the page.
 */
export const stampAttestations = (
  input: unknown,
  kept: ReadonlySet<string>,
  { email, now }: Attester
): unknown => {
  const stamp = (transport: unknown): unknown => {
    if (
      typeof transport !== "object" ||
      transport === null ||
      Reflect.get(transport, "kind") !== "openai-compatible"
    ) {
      return transport;
    }
    const attestation: unknown = Reflect.get(transport, "euAttestation");
    if (typeof attestation !== "object" || attestation === null) {
      return transport;
    }
    if (kept.has(JSON.stringify(attestation))) {
      return transport;
    }
    const by: unknown = Reflect.get(attestation, "by");
    if (by !== undefined && by !== email) {
      throw new AttestationError();
    }
    const basis: unknown = Reflect.get(attestation, "basis");
    return {
      ...transport,
      euAttestation: {
        basis,
        by: email,
        at: now.toISOString(),
      },
    };
  };
  if (typeof input !== "object" || input === null) {
    return input;
  }
  const failover: unknown = Reflect.get(input, "failover");
  return {
    ...input,
    primary: stamp(Reflect.get(input, "primary")),
    ...(Array.isArray(failover) ? { failover: failover.map(stamp) } : {}),
  };
};

/** The attestations `config`'s transports carry, as JSON. */
export const attestationsOf = (
  config: Pick<ModelTransportConfig, "primary" | "failover"> | null
): Set<string> => {
  const found = new Set<string>();
  for (const transport of config === null
    ? []
    : [config.primary, ...config.failover]) {
    const attestation: ResidencyAttestation | undefined =
      transport.kind === "openai-compatible"
        ? transport.euAttestation
        : undefined;
    if (attestation !== undefined) {
      found.add(JSON.stringify(attestation));
    }
  }
  return found;
};
