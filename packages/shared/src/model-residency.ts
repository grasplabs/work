import type { ModelResidency, ModelTransportKind } from "./model-transport.ts";

// The residency catalog: where a model call is processed, one reviewed
// entry per route (a transport, a provider, the endpoint's host). Core
// checks every call's route against it before anything is sent, and the
// host each request actually goes to on every request
// (src/model-residency-guard.ts); the admin shows it in plain words and
// lists the organization's AI subprocessors from it.
//
// Each entry records where inference runs, everything the request passes
// through on the way (a gateway hop processes the request too), what the
// provider keeps, and the documentation or contract that says so. An
// entry is EU-capable only with a documented EU basis (`eu: "documented"`),
// or where the processing location can't be read from the endpoint and
// staff record who vouched for it, on what basis (`eu: "attested"`, with
// the transport's `euAttestation`). Anything else is `eu: "no"`: nothing
// is assumed. A change here is a reviewed change, like a hosting policy.

/** Whether an entry's route may carry an EU organization's calls. */
export type EuBasis = "documented" | "attested" | "no";

/** A party that processes a call's content on its way to the answer. */
export interface Subprocessor {
  name: string;
  /** What it does with the call. */
  role: string;
  /** Where it does it, in plain words. */
  location: string;
}

export interface ResidencyEntry {
  id: string;
  transport: ModelTransportKind;
  /** The provider, as the gateway names models (`<provider>/<model>`); `*` for any. */
  provider: string;
  /**
   * The hosts requests go to: exact names, or `.suffix` for any host
   * under a domain. A route whose host matches none is no entry's.
   */
  hosts: readonly string[];
  /** Where the model runs, in plain words. */
  inference: string;
  /** The region label shown and recorded with each call, such as `eu-central-1`. */
  region: string;
  /** Who processes the call, in order, the model's provider last. */
  subprocessors: readonly Subprocessor[];
  /** What the provider keeps of prompts and answers. */
  retention: string;
  eu: EuBasis;
  /** The documentation or agreement each claim above rests on. */
  basis: readonly string[];
}

const cloudflare: Subprocessor = {
  name: "Cloudflare",
  role: "AI Gateway: routes the call, logs metadata only",
  location: "Cloudflare's global network",
};

const aws: Subprocessor = {
  name: "Amazon Web Services",
  role: "Amazon Bedrock: runs Claude",
  location: "EU regions (EU inference profile from Frankfurt)",
};

const anthropic: Subprocessor = {
  name: "Anthropic",
  role: "Runs Claude",
  location: "United States",
};

const openai: Subprocessor = {
  name: "OpenAI",
  role: "Runs GPT models",
  location: "United States",
};

const openrouter: Subprocessor = {
  name: "OpenRouter",
  role: "Routes the call to a provider of the model",
  location: "United States",
};

const awsBasis = [
  // Bedrock keeps neither prompts nor answers, nor shares them with model providers.
  "https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html",
  // The EU inference profile routes only within EU regions.
  "https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html",
  // AWS's GDPR Data Processing Addendum, part of the AWS Service Terms.
  "https://aws.amazon.com/compliance/gdpr-center/",
];

const cloudflareBasis = [
  "https://developers.cloudflare.com/ai-gateway/observability/logging/",
  "https://www.cloudflare.com/cloudflare-customer-dpa/",
];

/** Every route the gateway can take, reviewed. */
export const residencyCatalog: readonly ResidencyEntry[] = [
  {
    id: "cloudflare-ai-gateway/workers-ai",
    transport: "cloudflare-ai-gateway",
    provider: "workers-ai",
    hosts: ["workers-binding.ai"],
    inference: "Cloudflare Workers AI, on Cloudflare's global network",
    region: "global",
    subprocessors: [
      cloudflare,
      {
        name: "Cloudflare",
        role: "Workers AI: runs the model",
        location: "Cloudflare's global network",
      },
    ],
    retention:
      "Workers AI doesn't keep prompts or answers or train on them; AI Gateway logs metadata only.",
    eu: "no",
    basis: [
      "https://developers.cloudflare.com/workers-ai/platform/privacy/",
      ...cloudflareBasis,
    ],
  },
  {
    id: "cloudflare-ai-gateway/anthropic",
    transport: "cloudflare-ai-gateway",
    provider: "anthropic",
    hosts: ["workers-binding.ai"],
    inference: "Anthropic's API, in the United States",
    region: "us",
    subprocessors: [cloudflare, anthropic],
    retention: "Anthropic's API retention terms apply.",
    eu: "no",
    basis: [
      "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
      ...cloudflareBasis,
    ],
  },
  {
    id: "cloudflare-ai-gateway/openai",
    transport: "cloudflare-ai-gateway",
    provider: "openai",
    hosts: ["workers-binding.ai"],
    inference: "OpenAI's API, in the United States",
    region: "us",
    subprocessors: [cloudflare, openai],
    retention: "OpenAI's API retention terms apply.",
    eu: "no",
    basis: [
      "https://platform.openai.com/docs/guides/your-data",
      ...cloudflareBasis,
    ],
  },
  {
    // Bedrock is in the EU, but the gateway hop isn't pinned there.
    id: "cloudflare-ai-gateway/bedrock-eu",
    transport: "cloudflare-ai-gateway",
    provider: "bedrock-eu",
    hosts: ["workers-binding.ai"],
    inference:
      "Amazon Bedrock in the EU, reached through AI Gateway, which isn't pinned to the EU",
    region: "eu-central-1",
    subprocessors: [cloudflare, aws],
    retention:
      "Bedrock keeps neither prompts nor answers unless the AWS account turns invocation logging on.",
    eu: "no",
    basis: [...awsBasis, ...cloudflareBasis],
  },
  {
    id: "direct/bedrock-eu",
    transport: "direct",
    provider: "bedrock-eu",
    hosts: ["bedrock-mantle.eu-central-1.api.aws"],
    inference: "Amazon Bedrock in the EU (Frankfurt, EU inference profile)",
    region: "eu-central-1",
    subprocessors: [aws],
    retention:
      "Bedrock keeps neither prompts nor answers unless the AWS account turns invocation logging on.",
    eu: "documented",
    basis: awsBasis,
  },
  {
    id: "direct/anthropic",
    transport: "direct",
    provider: "anthropic",
    hosts: ["api.anthropic.com"],
    inference: "Anthropic's API, in the United States",
    region: "us",
    subprocessors: [anthropic],
    retention: "Anthropic's API retention terms apply.",
    eu: "no",
    basis: [
      "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
    ],
  },
  {
    id: "direct/openai",
    transport: "direct",
    provider: "openai",
    hosts: ["api.openai.com"],
    inference: "OpenAI's API, in the United States",
    region: "us",
    subprocessors: [openai],
    retention: "OpenAI's API retention terms apply.",
    eu: "no",
    basis: ["https://platform.openai.com/docs/guides/your-data"],
  },
  {
    // OpenRouter routes to whichever provider of the model it picks; its
    // EU routing isn't documented for every account, so nothing here
    // counts on it.
    id: "openrouter/*",
    transport: "openrouter",
    provider: "*",
    hosts: ["openrouter.ai"],
    inference:
      "A provider of the model OpenRouter picks, mostly in the United States",
    region: "global",
    subprocessors: [
      openrouter,
      {
        name: "The model's provider",
        role: "Runs the model",
        location: "Where OpenRouter routes it",
      },
    ],
    retention:
      "OpenRouter keeps no prompts or answers unless logging is turned on; the provider's terms apply.",
    eu: "no",
    basis: [
      "https://openrouter.ai/docs/features/privacy-and-logging",
      "https://openrouter.ai/privacy",
    ],
  },
  {
    // Azure OpenAI in an EU region with an EU Data Zone deployment stays
    // in the EU, but neither shows in the endpoint's host: staff attest it.
    id: "openai-compatible/azure-openai",
    transport: "openai-compatible",
    provider: "*",
    hosts: [
      ".openai.azure.com",
      ".cognitiveservices.azure.com",
      ".services.ai.azure.com",
    ],
    inference: "Azure OpenAI, in the Azure region of the client's resource",
    region: "azure",
    subprocessors: [
      {
        name: "Microsoft",
        role: "Azure OpenAI: runs the model",
        location: "The Azure region, or data zone, of the deployment",
      },
    ],
    retention:
      "Azure OpenAI keeps prompts and answers for abuse monitoring unless the client's exemption turns it off.",
    eu: "attested",
    basis: [
      "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/deployment-types",
      "https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/openai/data-privacy",
    ],
  },
  {
    // A model on the deployment's own network (on-prem): processed where
    // the deployment runs, which its operator vouches for.
    id: "openai-compatible/private-network",
    transport: "openai-compatible",
    provider: "*",
    hosts: [],
    inference: "A model on the deployment's own network",
    region: "self-hosted",
    subprocessors: [],
    retention: "Whatever the deployment's own model server keeps.",
    eu: "attested",
    basis: [],
  },
  {
    id: "openai-compatible/other",
    transport: "openai-compatible",
    provider: "*",
    hosts: ["*"],
    inference: "A custom endpoint, where its operator runs it",
    region: "unknown",
    subprocessors: [
      {
        name: "The endpoint's operator",
        role: "Runs or routes the model",
        location: "Not documented",
      },
    ],
    retention: "Not documented.",
    eu: "no",
    basis: [],
  },
];

/** Whether `host` matches one of an entry's `hosts`. */
const hostMatches = (patterns: readonly string[], host: string): boolean =>
  patterns.some((pattern) =>
    pattern.startsWith(".")
      ? host.endsWith(pattern) && host.length > pattern.length
      : pattern === "*" || pattern === host
  );

/** The id of the catalog's entry for a model on the deployment's own network. */
export const privateNetworkEntryId = "openai-compatible/private-network";

/**
 * The catalog's entry for a route: its transport, the provider of the
 * model, and the host it sends to (`privateHost` when it is one of the
 * deployment's own, on-prem). An entry with a host of its own wins over
 * the catch-all. `undefined` when none matches: such a route is no EU
 * route, and the gateway refuses it to an EU organization.
 */
export const residencyEntryOf = (route: {
  transport: ModelTransportKind;
  provider: string;
  host: string;
  privateHost?: boolean;
}): ResidencyEntry | undefined => {
  if (route.transport === "openai-compatible" && route.privateHost === true) {
    return residencyCatalog.find(({ id }) => id === privateNetworkEntryId);
  }
  const candidates = residencyCatalog.filter(
    (entry) =>
      entry.transport === route.transport &&
      (entry.provider === "*" || entry.provider === route.provider) &&
      hostMatches(entry.hosts, route.host)
  );
  return (
    candidates.find((entry) => !entry.hosts.includes("*")) ?? candidates[0]
  );
};

/**
 * Whether a route of `entry` may carry the calls of an organization whose
 * residency is `residency`: any route for `global`; for `eu`, a documented
 * EU route, or an attested one whose transport carries staff's
 * attestation (`attested`).
 */
export const residencyAllows = (
  residency: ModelResidency,
  entry: ResidencyEntry | undefined,
  attested: boolean
): boolean => {
  if (residency === "global") {
    return true;
  }
  if (entry === undefined) {
    return false;
  }
  return entry.eu === "documented" || (entry.eu === "attested" && attested);
};

/**
 * Where an organization's AI runs, in plain words, from its routes'
 * entries: "AI runs in the EU (Amazon Bedrock in the EU (Frankfurt, EU
 * inference profile))", or where each route runs when not all in the EU.
 */
export const processingWords = (
  entries: readonly ResidencyEntry[],
  residency: ModelResidency
): string => {
  const unique = [
    ...new Map(entries.map((entry) => [entry.id, entry])).values(),
  ];
  if (unique.length === 0) {
    return "AI isn't set up: no allowed model can be reached.";
  }
  const where = unique.map(({ inference }) => inference).join("; ");
  const inEu = unique.every(({ eu }) => eu !== "no");
  if (inEu) {
    return `AI runs in the EU (${where}).`;
  }
  return residency === "eu"
    ? `AI can't run: no allowed model is reached in the EU (${where}).`
    : `AI runs outside the EU (${where}).`;
};

/** The parties that process an organization's AI calls, each once. */
export const subprocessorsOf = (
  entries: readonly ResidencyEntry[]
): Subprocessor[] => {
  const seen = new Map<string, Subprocessor>();
  for (const entry of entries) {
    for (const party of entry.subprocessors) {
      seen.set(`${party.name}\n${party.role}`, party);
    }
  }
  return [...seen.values()];
};
