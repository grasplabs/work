import { z } from "zod";

// MODEL_TRANSPORT (core's src/model-transport*.ts): how a deployment
// reaches its models. An operational setting, not the organization's
// policy: staff change it any time, and the model gateway in core applies
// the same allowlist, rules, budgets, ledger and audit whatever it is.
// What it may never do is send a call outside the residency the
// organization's hosting policy requires (`residency`): core checks every
// route against the reviewed residency catalog (./model-residency.ts)
// before a request is sent, and its endpoint's host again on every
// request.
//
// It never holds a key. A transport names its keys (`key`), and the
// values are entries of the `MODEL_PROVIDER_KEYS` secret: on a hosted
// deployment the admin gives core only the entries its transports name,
// from Secrets Store (copied in from 1Password); on-prem, the deployment's
// own secret. Nothing writes a key to D1, a var or a log.

/** A key's name in `MODEL_PROVIDER_KEYS`: lowercase letters, digits and dashes. */
export const providerKeyNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u, "Lowercase letters, digits and dashes");

/**
 * `MODEL_PROVIDER_KEYS`: the provider keys a deployment's transports name,
 * by name. A Worker secret, never a var.
 */
export const modelProviderKeysSchema = z.record(
  providerKeyNameSchema,
  z.string().min(1).max(4096)
);
export type ModelProviderKeys = z.infer<typeof modelProviderKeysSchema>;

/** A host name, as a URL's host has it: lowercase, no port. */
export const endpointHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/u, "A lowercase host name");

/**
 * A custom endpoint's base URL, by its shape: an absolute URL with no
 * credentials, query or fragment. Where it may point is core's to check
 * (src/model-endpoint-guard.ts), at every request: no private range, no
 * metadata address, HTTPS unless the deployment is on-prem and named the
 * host as its own (`privateHosts`).
 */
export const endpointUrlSchema = z
  .url()
  .max(512)
  .refine(
    (value) => {
      const url = URL.parse(value);
      return (
        url !== null &&
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    },
    { message: "An http(s) URL without credentials, query or fragment" }
  );

/** A model as the gateway names it, by its shape: `<provider>/<model>`. */
const modelRefShape = z.string().regex(/^[^/\s]+\/\S+$/u);

/** A model's name at a custom endpoint, such as an Azure deployment's. */
const upstreamModelSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.:/-]+$/u);

/**
 * Staff's record that a custom endpoint processes in the EU, for a
 * catalog entry that takes one (`attested`, ./model-residency.ts): who
 * vouched, when, and the documentation or contract it rests on. Audited
 * by the admin when it is set.
 */
export const residencyAttestationSchema = z.strictObject({
  basis: z.url().max(512),
  by: z.email(),
  at: z.iso.datetime(),
});
export type ResidencyAttestation = z.infer<typeof residencyAttestationSchema>;

/** The ways to reach models, and what each one names. */
export const modelTransportSchema = z.discriminatedUnion("kind", [
  /**
   * Cloudflare AI Gateway over the AI binding: the gateway `MODEL_GATEWAY`
   * names, which holds or pays for the provider keys. Hosted only.
   */
  z.strictObject({ kind: z.literal("cloudflare-ai-gateway") }),
  /** OpenRouter, with Grasp's or the client's OpenRouter key. */
  z.strictObject({
    kind: z.literal("openrouter"),
    key: providerKeyNameSchema.default("openrouter"),
  }),
  /** Each provider's own API, with a key of its own. */
  z
    .strictObject({
      kind: z.literal("direct"),
      anthropic: z.strictObject({ key: providerKeyNameSchema }).optional(),
      openai: z.strictObject({ key: providerKeyNameSchema }).optional(),
      /** Claude in Amazon Bedrock, Frankfurt, through its EU inference profile. */
      "bedrock-eu": z.strictObject({ key: providerKeyNameSchema }).optional(),
    })
    .refine(
      (direct) =>
        direct.anthropic !== undefined ||
        direct.openai !== undefined ||
        direct["bedrock-eu"] !== undefined,
      { message: "At least one provider" }
    ),
  /**
   * An OpenAI-compatible endpoint (chat completions), such as a client's
   * Azure OpenAI or a router of its own: the allowed models it serves,
   * and each one's name there.
   */
  z.strictObject({
    kind: z.literal("openai-compatible"),
    /** Its name, as Setup, the ledger and the audit log show it. */
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/u),
    baseUrl: endpointUrlSchema,
    key: providerKeyNameSchema.optional(),
    models: z
      .record(modelRefShape, upstreamModelSchema)
      .refine((models) => Object.keys(models).length > 0, {
        message: "At least one model",
      }),
    euAttestation: residencyAttestationSchema.optional(),
  }),
]);
export type ModelTransport = z.infer<typeof modelTransportSchema>;
export type ModelTransportKind = ModelTransport["kind"];

export const modelTransportKinds = [
  "cloudflare-ai-gateway",
  "openrouter",
  "direct",
  "openai-compatible",
] as const satisfies readonly ModelTransportKind[];

/**
 * Where an organization's model calls may be processed: `eu`, only routes
 * the residency catalog documents (or staff attest) as processing in the
 * EU; `global`, anywhere. Set from the organization's hosting policy by
 * the admin, and by the deployment's own config on-prem: data, not code,
 * so a new policy preset only maps to one of these.
 */
export const modelResidencies = ["eu", "global"] as const;
export type ModelResidency = (typeof modelResidencies)[number];

/**
 * The most transports a deployment fails over to, in order: each one is
 * a provider request that may be refused again, so a short list.
 */
export const maxFailoverTransports = 2;

/** The `MODEL_TRANSPORT` var. */
export const modelTransportConfigSchema = z.strictObject({
  /** The transport every call takes while it works. */
  primary: modelTransportSchema,
  /**
   * Where a call goes, in order, while the primary's circuit is open or
   * once it refused the call before taking it on (credentials or rate
   * limit). Off (empty) unless staff set it; never outside `residency`.
   */
  failover: z
    .array(modelTransportSchema)
    .max(maxFailoverTransports)
    .default([]),
  residency: z.enum(modelResidencies).default("global"),
  /**
   * Hosts on the deployment's own private network a custom endpoint may
   * name, over plain HTTP too: on-prem only (core ignores them anywhere
   * else, and the admin refuses them for a hosted client). Never a
   * metadata address.
   */
  privateHosts: z.array(endpointHostSchema).max(8).default([]),
});
export type ModelTransportConfig = z.output<typeof modelTransportConfigSchema>;

/** Every deployment's transport until one is set: today's AI Gateway. */
export const defaultModelTransport: ModelTransportConfig = {
  primary: { kind: "cloudflare-ai-gateway" },
  failover: [],
  residency: "global",
  privateHosts: [],
};

/** The key an EU organization's default route takes, in `MODEL_PROVIDER_KEYS`. */
export const bedrockEuKeyName = "bedrock-eu";

/**
 * An EU organization's transport until staff set another: Claude in
 * Amazon Bedrock, Frankfurt, reached directly. AI Gateway isn't pinned to
 * the EU, so an EU organization's calls never pass through it.
 */
export const euModelTransport: ModelTransportConfig = {
  primary: { kind: "direct", "bedrock-eu": { key: bedrockEuKeyName } },
  failover: [],
  residency: "eu",
  privateHosts: [],
};

/**
 * The models an EU organization allows until staff change its
 * `MODEL_GATEWAY`: Claude in Bedrock's EU inference profile, the first
 * chat's default. Workers AI's defaults aren't pinned to the EU.
 */
export const euGatewayModels = [
  "bedrock-eu/claude-sonnet-5-5",
  "bedrock-eu/claude-haiku-5-5",
] as const;

/** The provider keys `config`'s transports name, each once. */
export const providerKeysNamed = (
  config: Pick<ModelTransportConfig, "primary" | "failover">
): string[] => {
  const names = new Set<string>();
  for (const transport of [config.primary, ...config.failover]) {
    if (transport.kind === "openrouter") {
      names.add(transport.key);
    } else if (transport.kind === "direct") {
      for (const provider of [
        transport.anthropic,
        transport.openai,
        transport["bedrock-eu"],
      ]) {
        if (provider !== undefined) {
          names.add(provider.key);
        }
      }
    } else if (
      transport.kind === "openai-compatible" &&
      transport.key !== undefined
    ) {
      names.add(transport.key);
    }
  }
  return [...names];
};
