// @vitest-environment happy-dom
import { aiProviders } from "@grasp-os/shared/ai-providers";
import type {
  AiModelChoice,
  AiProviderAdd,
  AiProviderListed,
  AiProvidersListing,
  AiProviderTest,
  AiSource,
  OrganizationProviderId,
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

import { AiStep, modelsToOffer } from "./ai-step.tsx";
import { Explained, Seen } from "./setup-parts.tsx";

// The onboarding's AI step against core's `aiProviders` as the page
// reaches it over RPC, faked: it keeps the key an admin saves and the
// model they choose, answers the test as told, and tells the step's next
// read whether a model is ready for calls, so what the step shows after
// going on is what core holds.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A key as an admin pastes it. */
const pastedKey = "sk-test-0123456789abcdefa3f2";

/** Each provider's catalog, as core offers it: more models than the ones most choose. */
const catalogs: Record<OrganizationProviderId, AiProviderListed["models"]> = {
  anthropic: [
    { model: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { model: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
    { model: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { model: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { model: "anthropic/claude-haiku-5-5", name: "Claude Haiku 5.5" },
  ],
  openai: [
    { model: "openai/gpt-5.5", name: "GPT-5.5" },
    { model: "openai/gpt-4.1", name: "GPT-4.1" },
  ],
  mistral: [],
  openrouter: [],
  "openai-compatible": [],
};

const offered: AiProvidersListing["offered"] = (
  ["anthropic", "openai", "openai-compatible"] as const
).map((provider) => ({
  provider,
  label: aiProviders[provider].label,
  whereItRuns: aiProviders[provider].whereItRuns,
  models: catalogs[provider],
}));

/** Core's AI providers: what an admin saved and chose, and each change asked. */
const fakeAiProviders = (
  tested: (model: string) => AiProviderTest,
  /** Whether this deployment has Grasp's key for Grasp's AI. */
  graspAvailable = false
) => {
  const asked: unknown[][] = [];
  let source: AiSource = "own";
  let providers: AiProviderListed[] = [];
  let choice: AiModelChoice | null = null;
  const api = {
    list: async (): Promise<AiProvidersListing> => {
      await Promise.resolve();
      return {
        source,
        grasp: {
          available: graspAvailable,
          model: {
            model: "anthropic/claude-sonnet-5-5",
            name: "Claude Sonnet 5.5",
          },
          whereItRuns: "Anthropic, United States",
          month: { spentUsd: 0, limitUsd: 100, reached: false },
        },
        providers,
        offered,
        choice,
        platform: [],
      };
    },
    add: async (request: AiProviderAdd): Promise<AiProviderListed> => {
      await Promise.resolve();
      asked.push(["add", request]);
      const added: AiProviderListed = {
        provider: request.provider,
        mask: `…${request.key.slice(-4)}`,
        baseUrl: "baseUrl" in request ? request.baseUrl : null,
        addedAt: 0,
        updatedAt: 0,
        label: aiProviders[request.provider].label,
        whereItRuns: aiProviders[request.provider].whereItRuns,
        status: null,
        models: catalogs[request.provider],
      };
      providers = [added];
      return added;
    },
    test: async (
      provider: OrganizationProviderId,
      model?: string
    ): Promise<AiProviderTest> => {
      await Promise.resolve();
      asked.push(["test", provider, model]);
      return tested(model ?? "");
    },
    setModels: async (next: { defaultModel: string }): Promise<void> => {
      await Promise.resolve();
      asked.push(["models", next]);
      choice = { defaultModel: next.defaultModel, fallbacks: [] };
    },
    setSource: async (next: AiSource): Promise<void> => {
      await Promise.resolve();
      asked.push(["source", next]);
      source = next;
    },
    remove: async (provider: OrganizationProviderId): Promise<void> => {
      await Promise.resolve();
      asked.push(["remove", provider]);
      providers = providers.filter((each) => each.provider !== provider);
    },
  };
  return { api, asked };
};

let root: Root | undefined;

/** The step on what core lists, read again after each change; `went` hears the admin go on. */
const shown = async (
  api: ReturnType<typeof fakeAiProviders>["api"]
): Promise<{ went: () => number }> => {
  let went = 0;
  const core = {
    withSession: async <T,>(
      action: (session: { aiProviders: typeof api }) => Promise<T>
    ): Promise<T> => await action({ aiProviders: api }),
  };
  const rootRoute = createRootRoute({
    loader: async () => {
      const listing = await api.list();
      // As core's chat models say it: ready once a connected provider's model is chosen.
      return {
        listing,
        ready: listing.choice !== null || listing.source === "grasp",
      };
    },
    component: () => (
      <Seen value>
        <Explained value={{ explained: true, onExplained: () => {} }}>
          <AiStep
            ai={rootRoute.useLoaderData()}
            lines={{ title: "Which AI should I think with?", sentence: "" }}
            onConnected={() => {
              went += 1;
            }}
            onDone={() => {}}
          />
        </Explained>
      </Seen>
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
  return { went: () => went };
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

/** The control labelled `label`, to press. */
const labelledControl = (label: string): HTMLElement => {
  const found = labelled(label);
  if (!(found instanceof HTMLElement)) {
    throw new TypeError(`${label} can't be pressed`);
  }
  return found;
};

const textField = (label: string): HTMLInputElement => {
  const found = labelled(label);
  if (!(found instanceof HTMLInputElement)) {
    throw new TypeError(`${label} is no field`);
  }
  return found;
};

const choice = (label: string): HTMLSelectElement => {
  const found = labelled(label);
  if (!(found instanceof HTMLSelectElement)) {
    throw new TypeError(`${label} is no choice`);
  }
  return found;
};

/** What the choice labelled `label` offers, by name. */
const options = (label: string): string[] =>
  [...choice(label).options].map((each) => each.textContent ?? "");

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

const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === name
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

const text = (): string => document.body.textContent ?? "";

describe("the onboarding's AI step", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("saves the key, asks the chosen model one question, and goes on once it answered", async () => {
    const { api, asked } = fakeAiProviders((model) => ({ ok: true, model }));
    const { went } = await shown(api);

    // Nothing to go on with until there is a key.
    expect(button("Continue").disabled).toBeTruthy();
    await enter(textField("Key"), pastedKey);
    await press(button("Continue"));

    expect({
      asked,
      went: went(),
      connected: text().includes("Connected: Anthropic"),
    }).toStrictEqual({
      asked: [
        ["add", { provider: "anthropic", key: pastedKey }],
        ["test", "anthropic", "anthropic/claude-sonnet-5-5"],
        ["models", { defaultModel: "anthropic/claude-sonnet-5-5" }],
      ],
      went: 1,
      connected: true,
    });
    // The key itself is nowhere on the page once it is saved.
    expect(document.body.innerHTML).not.toContain(pastedKey);
  });

  it("offers Grasp's AI first where the deployment has it, and going on sets the organization's AI to it with nothing to fill in", async () => {
    const { api, asked } = fakeAiProviders(
      (model) => ({ ok: true, model }),
      true
    );
    const { went } = await shown(api);

    expect({
      offered: text().includes("Use Grasp’s AI"),
      // Nothing to fill in: no key is asked for.
      keyAsked: [...document.querySelectorAll("label")].some(
        (each) => each.textContent?.trim() === "Key"
      ),
    }).toStrictEqual({ offered: true, keyAsked: false });
    await press(button("Continue"));

    expect({
      asked,
      went: went(),
      ready: text().includes("On Grasp’s AI: Claude Sonnet 5.5"),
    }).toStrictEqual({ asked: [["source", "grasp"]], went: 1, ready: true });
  });

  it("takes the organization's own key where they choose it over Grasp's AI", async () => {
    const { api, asked } = fakeAiProviders(
      (model) => ({ ok: true, model }),
      true
    );
    await shown(api);

    await press(labelledControl("Use your own key"));
    await enter(textField("Key"), pastedKey);
    await press(button("Continue"));

    expect(asked.map(([what]) => what)).toStrictEqual([
      "add",
      "test",
      "models",
    ]);
  });

  it("stays on the step and says why when the provider refuses the key: no model is chosen, and the key isn't kept", async () => {
    const { api, asked } = fakeAiProviders((model) => ({
      ok: false,
      model,
      code: "model.provider_key_failed",
    }));
    const { went } = await shown(api);

    await enter(textField("Key"), pastedKey);
    await press(button("Continue"));

    const { providers: kept } = await api.list();
    expect(kept).toStrictEqual([]);
    expect({
      chosen: asked.some(([what]) => what === "models"),
      went: went(),
      why: text().includes("Anthropic refused that key."),
      // Still asked for: the next key replaces the one refused.
      asking: textField("Key").type,
    }).toStrictEqual({
      chosen: false,
      went: 0,
      why: true,
      asking: "password",
    });
  });

  it("offers the models most choose first, and the provider's whole list once asked for", async () => {
    const { api, asked } = fakeAiProviders((model) => ({ ok: true, model }));
    await shown(api);

    expect(options("Model")).toStrictEqual([
      "Claude Sonnet 5.5",
      "Claude Opus 5.5",
      "Claude Haiku 5.5",
    ]);
    await press(button("Use a different model"));
    expect(options("Model")).toStrictEqual(
      catalogs.anthropic.map(({ name }) => name)
    );

    await enter(choice("Model"), "anthropic/claude-sonnet-4-6");
    await enter(textField("Key"), pastedKey);
    await press(button("Continue"));
    expect(asked.at(-1)).toStrictEqual([
      "models",
      { defaultModel: "anthropic/claude-sonnet-4-6" },
    ]);
  });

  it("asks a custom endpoint for its address and the model it serves", async () => {
    const { api, asked } = fakeAiProviders((model) => ({ ok: true, model }));
    await shown(api);

    await enter(choice("Provider"), "openai-compatible");
    await enter(textField("Key"), pastedKey);
    expect(button("Continue").disabled).toBeTruthy();
    await enter(textField("Base URL"), "https://models.example.com/v1");
    await enter(textField("Model"), "llama-3.3-70b");
    await press(button("Continue"));

    expect(asked).toStrictEqual([
      [
        "add",
        {
          provider: "openai-compatible",
          key: pastedKey,
          baseUrl: "https://models.example.com/v1",
        },
      ],
      ["test", "openai-compatible", "openai-compatible/llama-3.3-70b"],
      ["models", { defaultModel: "openai-compatible/llama-3.3-70b" }],
    ]);
  });
});

describe("the models offered on the AI step", () => {
  it("are every model of a provider whose catalog has none of the ones most choose", () => {
    const models = [{ model: "openai/gpt-4.1", name: "GPT-4.1" }];
    expect(modelsToOffer({ provider: "openai", models }, false)).toStrictEqual(
      models
    );
  });
});
