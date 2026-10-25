// Who made a model, from its ID as the model gateway names it
// (`provider/model`). The maker is what people recognise when they pick a
// model, not the provider that serves it: Workers AI runs DeepSeek's,
// Z.ai's, Meta's and others' models under `workers-ai/@cf/<org>/<model>`,
// and Bedrock serves Anthropic's. Neither core's catalogue (pi-ai's) nor
// `@grasp-os/shared` names a model's maker, so this is a plain table: the
// org of a Workers AI model, otherwise the provider, to the maker's name.
// A key not in it shows as itself.

/** Each maker's name, by a Workers AI org or a gateway provider. */
const makers: Readonly<Record<string, string>> = {
  // Gateway providers.
  anthropic: "Anthropic",
  "bedrock-eu": "Anthropic",
  openai: "OpenAI",
  "workers-ai": "Cloudflare",
  // Workers AI orgs (`@cf/<org>/…`).
  cloudflare: "Cloudflare",
  "deepseek-ai": "DeepSeek",
  google: "Google",
  "ibm-granite": "IBM",
  meta: "Meta",
  mistralai: "Mistral AI",
  moonshotai: "Moonshot AI",
  nvidia: "NVIDIA",
  qwen: "Qwen",
  "zai-org": "Z.ai",
};

/** The table's key for `model`: its Workers AI org, or else its provider. */
const makerKeyOf = (model: string): string => {
  const [provider = "", catalog, org] = model.split("/");
  if (provider === "workers-ai" && catalog === "@cf" && org !== undefined) {
    return org;
  }
  return provider;
};

/** The name of who made `model`, e.g. "DeepSeek" for Workers AI's DeepSeek. */
export const makerOf = (model: string): string => {
  const key = makerKeyOf(model);
  return Object.hasOwn(makers, key) ? (makers[key] ?? key) : key;
};
