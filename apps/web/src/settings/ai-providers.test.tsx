// @vitest-environment happy-dom
import {
  organizationProviderIds,
  aiProviders,
} from "@grasp-os/shared/ai-providers";
import type {
  AiModelChoice,
  AiModelChoiceNow,
  AiPlatformUse,
  AiProviderAdd,
  OrganizationProviderId,
  AiProviderListed,
  AiProvidersListing,
  AiProviderStatus,
  AiProviderTest,
} from "@grasp-os/shared/ai-providers";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AiProvidersSettings } from "./ai-providers.tsx";

// Settings › AI providers against core's `aiProviders` as the page reaches
// it over RPC (the boundary from the web app), faked: it keeps what an
// admin changes, as masks only, and answers the page's next read with it,
// so what the page shows after a change is what core holds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A key as an admin pastes it. */
const pastedKey = "sk-test-0123456789abcdefa3f2";

/** Each provider's catalog, as core offers it. */
const catalogs: Record<OrganizationProviderId, AiProviderListed["models"]> = {
  anthropic: [
    { model: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
  ],
  openai: [
    { model: "openai/gpt-5-mini", name: "GPT-5 mini" },
    { model: "openai/gpt-5.4", name: "GPT-5.4" },
    { model: "openai/gpt-4.1", name: "GPT-4.1" },
  ],
  mistral: [{ model: "mistral/mistral-small-latest", name: "Mistral Small" }],
  openrouter: [],
  "openai-compatible": [],
};

/** Core's AI providers, kept as an admin changes them, and each change asked. */
const fakeAiProviders = ({
  connected = [],
  choice: initial = null,
  tested = { ok: true, model: "openai/gpt-5-mini" },
  platform = [],
}: {
  connected?: { provider: OrganizationProviderId; status?: AiProviderStatus }[];
  choice?: AiModelChoiceNow | null;
  tested?: AiProviderTest;
  platform?: AiPlatformUse[];
} = {}) => {
  const asked: unknown[][] = [];
  const listed = (
    provider: OrganizationProviderId,
    key: string,
    baseUrl: string | null,
    status: AiProviderStatus | null = null
  ): AiProviderListed => ({
    provider,
    mask: `…${key.slice(-4)}`,
    baseUrl,
    addedAt: 0,
    updatedAt: 0,
    label: aiProviders[provider].label,
    whereItRuns: aiProviders[provider].whereItRuns,
    status,
    models: catalogs[provider],
  });
  let providers = connected.map(({ provider, status }) =>
    listed(provider, "sk-old-key-0000", null, status)
  );
  let choice: AiModelChoiceNow | null = initial;
  const api = {
    list: async (): Promise<AiProvidersListing> => {
      await Promise.resolve();
      return {
        providers,
        offered: organizationProviderIds.map((provider) => ({
          provider,
          label: aiProviders[provider].label,
          whereItRuns: aiProviders[provider].whereItRuns,
        })),
        choice,
        platform,
      };
    },
    add: async (request: AiProviderAdd): Promise<AiProviderListed> => {
      await Promise.resolve();
      asked.push(["add", request]);
      const added = listed(
        request.provider,
        request.key,
        "baseUrl" in request ? request.baseUrl : null
      );
      providers = [
        ...providers.filter(({ provider }) => provider !== request.provider),
        added,
      ];
      return added;
    },
    test: async (
      provider: OrganizationProviderId,
      model?: string
    ): Promise<AiProviderTest> => {
      await Promise.resolve();
      asked.push(["test", provider, model]);
      return tested;
    },
    setModels: async (next: AiModelChoice): Promise<void> => {
      await Promise.resolve();
      asked.push(["models", next]);
      choice = next;
    },
    remove: async (provider: OrganizationProviderId): Promise<void> => {
      await Promise.resolve();
      asked.push(["remove", provider]);
      providers = providers.filter((each) => each.provider !== provider);
      // As core keeps the choice: none of the removed provider's models,
      // its default none when it was one of them.
      const kept = (model: string) => !model.startsWith(`${provider}/`);
      choice =
        choice === null
          ? null
          : {
              defaultModel:
                choice.defaultModel !== null && kept(choice.defaultModel)
                  ? choice.defaultModel
                  : null,
              fallbacks: choice.fallbacks.filter(kept),
            };
    },
  };
  return { api, asked };
};

let root: Root | undefined;

/** The page on what `api` holds, for the organization's own admin when `editable`. */
const shown = async (
  api: ReturnType<typeof fakeAiProviders>["api"],
  editable = true
): Promise<void> => {
  const core = {
    withSession: async <T,>(
      action: (session: { aiProviders: typeof api }) => Promise<T>
    ): Promise<T> => await action({ aiProviders: api }),
  };
  const rootRoute = createRootRoute({
    loader: async () => await api.list(),
    component: () => (
      <AiProvidersSettings
        editable={editable}
        listing={rootRoute.useLoaderData()}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory(),
    context: { core },
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
};

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** The control labelled `label`, by its `<label>`. */
const labelled = (label: string): Element => {
  const found = [...document.querySelectorAll("label")].find(
    (each) => each.textContent?.trim() === label
  );
  const control =
    found === undefined
      ? null
      : document.querySelector(`[id="${found.htmlFor}"]`);
  if (control === null) {
    throw new TypeError(`No control labelled ${label}`);
  }
  return control;
};

/** The field labelled `label`. */
const textField = (label: string): HTMLInputElement => {
  const found = labelled(label);
  if (!(found instanceof HTMLInputElement)) {
    throw new TypeError(`${label} is no field`);
  }
  return found;
};

/** The choice labelled `label`. */
const choice = (label: string): HTMLSelectElement => {
  const found = labelled(label);
  if (!(found instanceof HTMLSelectElement)) {
    throw new TypeError(`${label} is no choice`);
  }
  return found;
};

/** Sets `value` on `field`, as React hears a person type or choose it. */
const enter = async (
  field: HTMLInputElement | HTMLSelectElement,
  value: string
): Promise<void> => {
  await act(async () => {
    const prototype = Reflect.getPrototypeOf(field) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      field,
      value
    );
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
    await Promise.resolve();
  });
  await settled();
};

/** The button named `name`, by its label or its text. */
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name ||
      each.textContent?.trim() === name
  );
  if (found === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  return found;
};

const press = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The page's text, without its markup. */
const text = (): string => document.body.textContent ?? "";

describe("Settings › AI providers", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("adds a provider in a password field, and shows only the key's mask once it is saved", async () => {
    const { api, asked } = fakeAiProviders();
    await shown(api);
    expect(text()).toContain("No AI provider is connected yet");

    await enter(choice("Provider"), "openai");
    expect(text()).toContain("Runs at: OpenAI, United States");
    const key = textField("Key");
    expect(key.type).toBe("password");
    await enter(key, pastedKey);
    await press(button("Save key"));

    const row =
      document.querySelector('ul[aria-label="Connected providers"]')
        ?.textContent ?? "";
    expect({
      asked,
      listed: row.includes("OpenAI"),
      masked: row.includes("Key: …a3f2"),
    }).toStrictEqual({
      asked: [["add", { provider: "openai", key: pastedKey }]],
      listed: true,
      masked: true,
    });
    // The key itself is nowhere on the page: not in its text or markup, nor in a field.
    expect({
      markup: document.body.innerHTML.includes(pastedKey),
      fields: [...document.querySelectorAll("input")].some(
        ({ value }) => value === pastedKey
      ),
    }).toStrictEqual({ markup: false, fields: false });
  });

  it("asks a custom endpoint for its base URL, and sends the key there", async () => {
    const { api, asked } = fakeAiProviders();
    await shown(api);

    await enter(choice("Provider"), "openai-compatible");
    expect(button("Save key").disabled).toBeTruthy();
    await enter(textField("Base URL"), "https://models.example.com/v1");
    await enter(textField("Key"), pastedKey);
    await press(button("Save key"));

    expect(asked).toStrictEqual([
      [
        "add",
        {
          provider: "openai-compatible",
          key: pastedKey,
          baseUrl: "https://models.example.com/v1",
        },
      ],
    ]);
    expect(document.body.innerHTML).not.toContain(pastedKey);
  });

  it("tests a provider with one call and says how it went in plain words", async () => {
    const working = fakeAiProviders({ connected: [{ provider: "openai" }] });
    await shown(working.api);
    await press(button("Test OpenAI"));
    expect(working.asked).toStrictEqual([["test", "openai", undefined]]);
    expect(document.querySelector("output")?.textContent).toBe(
      "It works: GPT-5 mini answered the test."
    );

    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const failing = fakeAiProviders({
      connected: [{ provider: "openai" }],
      tested: { ok: false, model: "openai/gpt-5-mini", code: "model.failed" },
    });
    await shown(failing.api);
    await press(button("Test OpenAI"));
    expect(document.querySelector("output")?.textContent).toBe(
      "The test didn't work. GPT-5 mini didn't answer: The model couldn't answer. Try again."
    );
  });

  it("says how each provider's calls went: working, not working and why, or not used yet", async () => {
    const at = Date.UTC(2026, 9, 29, 9, 30);
    const { api } = fakeAiProviders({
      connected: [
        {
          provider: "anthropic",
          status: {
            lastOkAt: at,
            lastFailedAt: null,
            lastFailure: null,
            lastStatus: null,
          },
        },
        {
          provider: "openai",
          status: {
            lastOkAt: at,
            lastFailedAt: at + 60_000,
            lastFailure: "auth",
            lastStatus: 401,
          },
        },
        { provider: "mistral" },
      ],
    });
    await shown(api);
    const rows = [
      ...document.querySelectorAll('ul[aria-label="Connected providers"] > li'),
    ].map((row) => row.textContent ?? "");

    expect(rows[0]).toContain("Working. Last used");
    expect(rows[1]).toContain("Not working: the last call");
    expect(rows[1]).toContain("failed because the provider refused the key.");
    expect(rows[2]).toContain("Not used yet.");
  });

  it("chooses the default model, then orders its fallbacks", async () => {
    const { api, asked } = fakeAiProviders({
      connected: [{ provider: "openai" }],
    });
    await shown(api);

    await enter(choice("Default model"), "openai/gpt-5.4");
    await enter(choice("Add a fallback"), "openai/gpt-4.1");
    await enter(choice("Add a fallback"), "openai/gpt-5-mini");
    await press(button("Move GPT-5 mini up"));
    await press(button("Remove GPT-4.1 from the fallbacks"));

    expect(asked).toStrictEqual([
      ["models", { defaultModel: "openai/gpt-5.4", fallbacks: [] }],
      [
        "models",
        { defaultModel: "openai/gpt-5.4", fallbacks: ["openai/gpt-4.1"] },
      ],
      [
        "models",
        {
          defaultModel: "openai/gpt-5.4",
          fallbacks: ["openai/gpt-4.1", "openai/gpt-5-mini"],
        },
      ],
      [
        "models",
        {
          defaultModel: "openai/gpt-5.4",
          fallbacks: ["openai/gpt-5-mini", "openai/gpt-4.1"],
        },
      ],
      [
        "models",
        { defaultModel: "openai/gpt-5.4", fallbacks: ["openai/gpt-5-mini"] },
      ],
    ]);
    expect(
      document.querySelector('ol[aria-label="Fallbacks"]')?.textContent
    ).toContain("GPT-5 mini");
  });

  it("replaces a key, and removes a provider once the admin confirms", async () => {
    const { api, asked } = fakeAiProviders({
      connected: [{ provider: "openai" }],
    });
    await shown(api);

    await press(button("Replace the key for OpenAI"));
    await enter(textField("New key for OpenAI"), pastedKey);
    await press(button("Save key"));
    expect(text()).toContain("Key: …a3f2");
    expect(document.body.innerHTML).not.toContain(pastedKey);

    await press(button("Remove OpenAI"));
    expect(asked.filter(([what]) => what === "remove")).toStrictEqual([]);
    const confirm = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((each) => each.textContent?.trim() === "Remove");
    if (confirm === undefined) {
      throw new TypeError("No confirmation");
    }
    await press(confirm);

    expect(asked).toStrictEqual([
      ["add", { provider: "openai", key: pastedKey }],
      ["remove", "openai"],
    ]);
    expect(text()).toContain("No AI provider is connected yet");
  });

  it("offers none of a removed provider's models, and asks for a new default before the fallbacks change when its was the default", async () => {
    const { api, asked } = fakeAiProviders({
      connected: [
        { provider: "anthropic" },
        { provider: "openai" },
        { provider: "mistral" },
      ],
      choice: {
        defaultModel: "anthropic/claude-haiku-4-5",
        fallbacks: ["openai/gpt-4.1", "mistral/mistral-small-latest"],
      },
    });
    await shown(api);
    const remove = async (label: string) => {
      await press(button(`Remove ${label}`));
      const confirm = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button'
        ),
      ].find((each) => each.textContent?.trim() === "Remove");
      if (confirm === undefined) {
        throw new TypeError("No confirmation");
      }
      await press(confirm);
    };

    // A fallback's provider removed: a later change sends none of its models.
    await remove("Mistral AI");
    await enter(choice("Add a fallback"), "openai/gpt-5-mini");
    // The default's provider removed: the fallbacks wait for a new default.
    await remove("Anthropic");
    const waiting = {
      defaultModel: choice("Default model").value,
      canRemoveFallback: !button("Remove GPT-4.1 from the fallbacks").disabled,
      asksForDefault: text().includes("Choose a new default model"),
    };
    await enter(choice("Default model"), "openai/gpt-5.4");

    expect(waiting).toStrictEqual({
      defaultModel: "",
      canRemoveFallback: false,
      asksForDefault: true,
    });
    expect(asked.filter(([what]) => what === "models")).toStrictEqual([
      [
        "models",
        {
          defaultModel: "anthropic/claude-haiku-4-5",
          fallbacks: ["openai/gpt-4.1", "openai/gpt-5-mini"],
        },
      ],
      [
        "models",
        {
          defaultModel: "openai/gpt-5.4",
          fallbacks: ["openai/gpt-4.1", "openai/gpt-5-mini"],
        },
      ],
    ]);
  });

  it("offers a custom model another admin chose meanwhile, once the page reads again", async () => {
    const { api } = fakeAiProviders({
      connected: [{ provider: "openai-compatible" }],
      choice: { defaultModel: "openai-compatible/llama-a", fallbacks: [] },
    });
    await shown(api);
    // Another admin chooses a model this page never named.
    await api.setModels({
      defaultModel: "openai-compatible/llama-b",
      fallbacks: [],
    });
    // Any change here reads the providers again.
    await press(button("Test OpenAI-compatible endpoint"));

    const picked = choice("Default model");
    expect({
      value: picked.value,
      offered: [...picked.options].map(({ value }) => value),
    }).toStrictEqual({
      value: "openai-compatible/llama-b",
      offered: ["openai-compatible/llama-b"],
    });
  });

  it("shows no earlier test's result for a key that replaced the one tested", async () => {
    const { api } = fakeAiProviders({ connected: [{ provider: "openai" }] });
    await shown(api);
    await press(button("Test OpenAI"));
    const before = document.querySelector("output")?.textContent ?? null;

    await press(button("Replace the key for OpenAI"));
    await enter(textField("New key for OpenAI"), pastedKey);
    await press(button("Save key"));

    expect({
      before,
      after: document.querySelector("output")?.textContent ?? null,
    }).toStrictEqual({
      before: "It works: GPT-5 mini answered the test.",
      after: null,
    });
  });

  it("shows the providers and models without a way to change them to anyone who can't", async () => {
    const { api } = fakeAiProviders({
      connected: [{ provider: "openai" }],
      choice: {
        defaultModel: "openai/gpt-5.4",
        fallbacks: ["openai/gpt-5-mini"],
      },
    });
    await shown(api, false);

    expect(text()).toContain("Key: …0000");
    expect(text()).toContain("GPT-5.4");
    expect(text()).toContain("GPT-5 mini");
    expect(document.querySelectorAll("input, select")).toHaveLength(0);
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  it("says which provider handles Grasp's own AI features, on Grasp's key, with nothing to switch", async () => {
    const openai = {
      id: "openai",
      label: aiProviders.openai.label,
      whereItRuns: aiProviders.openai.whereItRuns,
    } as const;
    const elevenLabs = {
      id: "elevenlabs",
      label: aiProviders.elevenlabs.label,
      whereItRuns: "ElevenLabs, European Union",
    } as const;
    const { api } = fakeAiProviders({
      connected: [{ provider: "mistral" }],
      platform: [
        { feature: "conversion", provider: openai, off: false },
        { feature: "transcription", provider: openai, off: false },
        { feature: "speech", provider: elevenLabs, off: false },
      ],
    });
    await shown(api);

    const section = [...document.querySelectorAll("section")].find(
      (each) =>
        each.querySelector("h2")?.textContent === "Grasp's own AI features"
    );
    expect(text()).toContain(
      "Grasp converts uploaded PDFs with OpenAI, United States, using Grasp's own key."
    );
    expect(text()).toContain(
      "Grasp transcribes interviews with OpenAI, United States, using Grasp's own key."
    );
    expect(text()).toContain(
      "Grasp reads the interview's questions aloud with ElevenLabs, European Union, using Grasp's own key."
    );
    expect(section?.querySelectorAll("input, select, button")).toHaveLength(0);
    expect(section?.textContent).toContain("Grasp's own provider keys");
  });

  it("says which of Grasp's own features are off where the deployment keeps everything in the EU and Grasp's project isn't there", async () => {
    const openai = {
      id: "openai",
      label: aiProviders.openai.label,
      whereItRuns: "OpenAI, United States",
    } as const;
    const elevenLabs = {
      id: "elevenlabs",
      label: aiProviders.elevenlabs.label,
      whereItRuns: "ElevenLabs, United States",
    } as const;
    const { api } = fakeAiProviders({
      platform: [
        { feature: "conversion", provider: null, off: false },
        { feature: "transcription", provider: openai, off: true },
        { feature: "speech", provider: elevenLabs, off: true },
      ],
    });
    await shown(api);

    expect(text()).toContain(
      "Interviews aren't transcribed: this deployment keeps everything in the EU, and OpenAI, United States isn't."
    );
    expect(text()).toContain(
      "The interview's questions aren't read aloud: this deployment keeps everything in the EU, and ElevenLabs, United States isn't."
    );
  });

  it("says when documents are converted on the deployment itself", async () => {
    const { api } = fakeAiProviders({
      platform: [{ feature: "conversion", provider: null, off: false }],
    });
    await shown(api);

    expect(text()).toContain(
      "Grasp converts uploaded documents on this deployment: nothing is sent out."
    );
  });
});
