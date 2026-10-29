/**
 * A model transport in plain words, and as the form that changes it
 * fills and reads its fields (src/admin/transport-form.tsx): on a
 * client's Setup and on Platform's AI page. The form only gathers what
 * staff typed; the admin checks it as core would
 * (src/clients/settings.ts, src/admin/platform-ai.ts).
 */
import type {
  ModelResidency,
  ModelTransport,
  ModelTransportKind,
} from "@grasp-os/shared/model-transport";

import type { TransportSource } from "../deploy/model-transport.ts";

/** Each way to reach models, as staff read it. */
export const kindWords: Readonly<Record<ModelTransportKind, string>> = {
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  openrouter: "OpenRouter",
  direct: "The providers' own APIs",
  "openai-compatible": "A custom endpoint (OpenAI-compatible)",
};

/** The providers a direct transport may reach, as staff read them. */
export const directProviders = [
  { id: "bedrock-eu", words: "Claude in Amazon Bedrock, EU" },
  { id: "anthropic", words: "Anthropic" },
  { id: "openai", words: "OpenAI" },
] as const;

/** One transport in words, with the names it gives, never a key's value. */
export const transportWords = (transport: ModelTransport): string => {
  if (transport.kind === "direct") {
    const providers = directProviders
      .filter(({ id }) => transport[id] !== undefined)
      .map(({ words }) => words);
    return `${kindWords.direct}: ${providers.join(", ")}`;
  }
  if (transport.kind === "openai-compatible") {
    return `${transport.name} at ${transport.baseUrl}`;
  }
  return kindWords[transport.kind];
};

/** Where its transport comes from, as staff read it. */
export const sourceWords = (
  source: TransportSource,
  residency: ModelResidency
): string => {
  const whose =
    residency === "eu" ? "EU organizations" : "organizations without one";
  const words: Record<TransportSource, string> = {
    setting: "Its own setting",
    platform: `The platform's default for ${whose}`,
    built_in: `The built-in default for ${whose}`,
  };
  return words[source];
};

/** Where AI may run, as staff read it. */
export const residencyWords: Readonly<Record<ModelResidency, string>> = {
  eu: "Only in the EU",
  global: "Anywhere",
};

/** The form's choice of a transport: one of the kinds, or none set. */
export type KindChoice = ModelTransportKind | "default";

/** What the form starts from for a transport: each field's value. */
export interface TransportFieldValues {
  kind: KindChoice;
  openrouterKey: string;
  directKeys: Readonly<Record<(typeof directProviders)[number]["id"], string>>;
  name: string;
  baseUrl: string;
  key: string;
  /** `<provider>/<model> = <its name there>`, a line each. */
  models: string;
  /** The EU attestation's basis; empty without one. */
  basis: string;
}

/** The fields' values with no transport: each kind's defaults. */
const emptyFieldValues: TransportFieldValues = {
  kind: "default",
  openrouterKey: "openrouter",
  directKeys: { "bedrock-eu": "bedrock-eu", anthropic: "", openai: "" },
  name: "",
  baseUrl: "",
  key: "",
  models: "",
  basis: "",
};

/** The fields' values for `transport`; each kind's defaults for none. */
export const fieldValuesOf = (
  transport: ModelTransport | null
): TransportFieldValues => {
  if (transport === null) {
    return emptyFieldValues;
  }
  const values = { ...emptyFieldValues, kind: transport.kind };
  switch (transport.kind) {
    case "openrouter": {
      return { ...values, openrouterKey: transport.key };
    }
    case "direct": {
      return {
        ...values,
        directKeys: {
          "bedrock-eu": transport["bedrock-eu"]?.key ?? "",
          anthropic: transport.anthropic?.key ?? "",
          openai: transport.openai?.key ?? "",
        },
      };
    }
    case "openai-compatible": {
      return {
        ...values,
        name: transport.name,
        baseUrl: transport.baseUrl,
        key: transport.key ?? "",
        models: Object.entries(transport.models)
          .map(([model, upstream]) => `${model} = ${upstream}`)
          .join("\n"),
        basis: transport.euAttestation?.basis ?? "",
      };
    }
    case "cloudflare-ai-gateway": {
      return values;
    }
    default: {
      return values;
    }
  }
};

/** Field `name` of `form`, trimmed; empty when it has none. */
const fieldOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** `<provider>/<model> = <name there>` lines as the endpoint's models. */
const modelsOf = (lines: string): Record<string, string> => {
  const models: Record<string, string> = {};
  for (const line of lines.split("\n")) {
    const [model = "", upstream = "", ...rest] = line.split("=");
    if (rest.length === 0 && model.trim() !== "" && upstream.trim() !== "") {
      models[model.trim()] = upstream.trim();
    }
  }
  return models;
};

/**
 * The transport the fields named `<prefix>-…` of `form` give for `kind`;
 * null for `default`. `attested` is whether staff attest a custom
 * endpoint processes in the EU: the attestation the page sends carries
 * only its basis (and `kept`, one it had, unchanged), as the admin
 * records who made it and when.
 */
export const transportOfForm = (
  form: FormData,
  prefix: string,
  kind: KindChoice,
  attestation: { attested: boolean; kept: unknown }
): unknown => {
  const field = (name: string): string => fieldOf(form, `${prefix}-${name}`);
  switch (kind) {
    case "default": {
      return null;
    }
    case "cloudflare-ai-gateway": {
      return { kind };
    }
    case "openrouter": {
      return { kind, key: field("openrouter-key") || "openrouter" };
    }
    case "direct": {
      return {
        kind,
        ...Object.fromEntries(
          directProviders.flatMap(({ id }) => {
            const key = field(`direct-${id}`);
            return key === "" ? [] : [[id, { key }]];
          })
        ),
      };
    }
    case "openai-compatible": {
      const key = field("key");
      const basis = field("basis");
      const keptBasis: unknown =
        typeof attestation.kept === "object" && attestation.kept !== null
          ? Reflect.get(attestation.kept, "basis")
          : undefined;
      let euAttestation: unknown = undefined;
      if (attestation.attested) {
        euAttestation = keptBasis === basis ? attestation.kept : { basis };
      }
      return {
        kind,
        name: field("name"),
        baseUrl: field("base-url"),
        ...(key === "" ? {} : { key }),
        models: modelsOf(field("models")),
        ...(euAttestation === undefined ? {} : { euAttestation }),
      };
    }
    default: {
      return null;
    }
  }
};
