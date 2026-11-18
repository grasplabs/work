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
  AiSource,
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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
  graspAvailable = false,
}: {
  /** Whether this deployment has Grasp's key for Grasp's AI. */
  graspAvailable?: boolean;
  connected?: { provider: OrganizationProviderId; status?: AiProviderStatus }[];
  choice?: AiModelChoiceNow | null;
  tested?: AiProviderTest;
  platform?: AiPlatformUse[];
} = {}) => {
  const asked: unknown[][] = [];
  let source: AiSource = "own";
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
        source,
        grasp: {
          available: graspAvailable,
          model: {
            model: "anthropic/claude-sonnet-5-5",
            name: "Claude Sonnet 5.5",
          },
          whereItRuns: "Anthropic, United States",
          month: { spentUsd: 12.5, limitUsd: 100, reached: false },
        },
        providers,
        offered: organizationProviderIds.map((provider) => ({
          provider,
          label: aiProviders[provider].label,
          whereItRuns: aiProviders[provider].whereItRuns,
          models: catalogs[provider],
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
    setSource: async (next: AiSource): Promise<void> => {
      await Promise.resolve();
      asked.push(["source", next]);
      source = next;
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

/** An element's words as people get them: not the ones it hides from them. */
const wordsOf = (element: Element): string => {
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) {
    return "";
  }
  for (const hidden of copy.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return copy.textContent.trim();
};

const press = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The button named `name`, by its label or its text. */
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === name || wordsOf(each) === name
  );
  if (found === undefined) {
    throw new TypeError(`No button ${name}`);
  }
  return found;
};

/** The control labelled `label`, by its `<label>`. */
const labelled = (label: string): Element => {
  const found = [...document.querySelectorAll("label")].find(
    (each) => wordsOf(each) === label
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

/** The choice labelled `label`: the control that opens its list. */
const choice = (label: string): HTMLElement => {
  const found = labelled(label);
  if (!(found instanceof HTMLElement) || found.role !== "combobox") {
    throw new TypeError(`${label} is no choice`);
  }
  return found;
};

/** Sets `value` in `field`, as React hears a person type it. */
const enter = async (field: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    const prototype = Reflect.getPrototypeOf(field) ?? {};
    Reflect.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      field,
      value
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await settled();
};

/** The options `control` offers, once it is opened: in its own list, not one still closing. */
const optionsOf = async (control: HTMLElement): Promise<HTMLElement[]> => {
  await press(control);
  const list = document.querySelector(
    `[id="${control.getAttribute("aria-controls") ?? ""}"]`
  );
  return [
    ...(list ?? document).querySelectorAll<HTMLElement>('[role="option"]'),
  ];
};

/** Chooses the option named `name` in the choice labelled `label`, as a person does. */
const pick = async (label: string, name: string): Promise<void> => {
  const offered = await optionsOf(choice(label));
  const option = offered.find((each) => wordsOf(each) === name);
  if (option === undefined) {
    throw new TypeError(`${label} offers no ${name}`);
  }
  await press(option);
};

/** The dialog's button named `name`. */
const dialogButton = (name: string): HTMLButtonElement => {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((each) => wordsOf(each) === name);
  if (found === undefined) {
    throw new TypeError(`No ${name} in the dialog`);
  }
  return found;
};

/** Chooses the provider named `name` in the Add dialog, by its row's label. */
const chooseProvider = async (name: string): Promise<void> => {
  const found = [...document.querySelectorAll("label")].find(
    (each) => wordsOf(each) === name
  );
  if (found === undefined) {
    throw new TypeError(`No provider ${name}`);
  }
  await press(found);
};

/** What a choice shows: a combobox's text, else its words. */
const shownIn = (control: Element): string =>
  control instanceof HTMLInputElement ? control.value : wordsOf(control);

/** The hold's confirmation, which a click on it opens: its yes. */
const confirmation = async (): Promise<HTMLElement> =>
  await vi.waitFor(() => {
    const yes = document.querySelector<HTMLElement>(
      '[data-agent-confirm="Delete key"]'
    );
    if (yes === null) {
      throw new TypeError("No confirmation");
    }
    return yes;
  });

/** Opens `label`'s Manage dialog, where its key is tested, replaced and deleted. */
const manage = async (label: string): Promise<void> => {
  await press(button(`Manage ${label}`));
};

/** Tests `label`'s key from its Manage dialog. */
const testKey = async (label: string): Promise<void> => {
  await manage(label);
  await press(dialogButton("Test"));
};

/** Deletes `label`'s key from its Manage dialog: a click on the hold asks, and its yes deletes. */
const deleteKey = async (label: string): Promise<void> => {
  await manage(label);
  await press(dialogButton("Delete key"));
  await press(await confirmation());
};

/** Replaces `label`'s key in its Manage dialog. */
const replaceKey = async (label: string, key: string): Promise<void> => {
  await manage(label);
  await enter(textField("New key"), key);
  await press(dialogButton("Replace key"));
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
    expect(text()).toContain("No provider is connected");

    await press(button("Add a provider"));
    await chooseProvider("OpenAI");
    // Where it runs, in place of the name said again.
    expect(text()).toContain("United States");
    const key = textField("Key");
    expect({ type: key.type, placeholder: key.placeholder }).toStrictEqual({
      type: "password",
      placeholder: "sk-proj-…",
    });
    await enter(key, pastedKey);
    await press(dialogButton("Add provider"));

    const row =
      document.querySelector('ul[aria-label="Connected providers"]')
        ?.textContent ?? "";
    expect({
      asked,
      listed: row.includes("OpenAI"),
      masked: row.includes("•••• a3f2"),
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

    await press(button("Add a provider"));
    await chooseProvider("OpenAI-compatible endpoint");
    // No address yet: nothing is sent, and the field says what it needs.
    await enter(textField("Key"), pastedKey);
    await press(dialogButton("Add provider"));
    const sentEarly = [...asked];
    await enter(textField("Address"), "https://models.example.com/v1");
    await press(dialogButton("Add provider"));

    expect(sentEarly).toStrictEqual([]);
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

  it("tests a provider with one call, says Works on the button, or Failed and why", async () => {
    const working = fakeAiProviders({ connected: [{ provider: "openai" }] });
    await shown(working.api);
    await testKey("OpenAI");
    expect(working.asked).toStrictEqual([["test", "openai", undefined]]);
    await vi.waitFor(() => {
      expect(text()).toContain("Works");
    });

    act(() => {
      root?.unmount();
    });
    document.body.replaceChildren();
    const failing = fakeAiProviders({
      connected: [{ provider: "openai" }],
      tested: { ok: false, model: "openai/gpt-5-mini", code: "model.failed" },
    });
    await shown(failing.api);
    await testKey("OpenAI");
    await vi.waitFor(() => {
      expect(text()).toContain(
        "Test failed: The model couldn't answer. Try again."
      );
    });
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
            failingClass: null,
            failingSince: null,
          },
        },
        {
          provider: "openai",
          status: {
            lastOkAt: at,
            lastFailedAt: at + 60_000,
            lastFailure: "auth",
            lastStatus: 401,
            failingClass: "refused",
            failingSince: at + 60_000,
          },
        },
        { provider: "mistral" },
      ],
    });
    await shown(api);
    const rows = [
      ...document.querySelectorAll('ul[aria-label="Connected providers"] > li'),
    ].map((row) => row.textContent ?? "");

    expect({
      working: (rows[0] ?? "").includes("Working"),
      failing: /It refused the key\..*Not working/u.test(rows[1] ?? ""),
      unused: (rows[2] ?? "").includes("Not used yet"),
    }).toStrictEqual({ working: true, failing: true, unused: true });
  });

  it("chooses the default model, then orders its fallbacks", async () => {
    const { api, asked } = fakeAiProviders({
      connected: [{ provider: "openai" }],
    });
    await shown(api);

    await pick("Default model", "GPT-5.4");
    await pick("Add a fallback", "GPT-4.1");
    await pick("Add a fallback", "GPT-5 mini");
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

  it("replaces a key, and deletes it once the admin confirms the hold", async () => {
    const { api, asked } = fakeAiProviders({
      connected: [{ provider: "openai" }],
    });
    await shown(api);

    await replaceKey("OpenAI", pastedKey);
    expect(text()).toContain("•••• a3f2");
    expect(document.body.innerHTML).not.toContain(pastedKey);

    await manage("OpenAI");
    await press(dialogButton("Delete key"));
    expect(asked.filter(([what]) => what === "remove")).toStrictEqual([]);
    await press(await confirmation());

    expect(asked).toStrictEqual([
      ["add", { provider: "openai", key: pastedKey }],
      ["remove", "openai"],
    ]);
    expect(text()).toContain("No provider is connected");
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
    const remove = deleteKey;

    // A fallback's provider removed: a later change sends none of its models.
    await remove("Mistral AI");
    await pick("Add a fallback", "GPT-5 mini");
    // The default's provider removed: the fallbacks wait for a new default.
    await remove("Anthropic");
    const waiting = {
      defaultModel: shownIn(choice("Default model")),
      canRemoveFallback: !button("Remove GPT-4.1 from the fallbacks").disabled,
      asksForDefault: text().includes("Choose a new default"),
    };
    await pick("Default model", "GPT-5.4");

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
    await testKey("OpenAI-compatible endpoint");

    const picked = choice("Default model");
    const shownNow = shownIn(picked);
    const offered = await optionsOf(picked);
    expect({
      value: shownNow,
      offered: offered.map(wordsOf),
    }).toStrictEqual({
      value: "llama-b",
      offered: ["llama-b"],
    });
  });

  it("shows no earlier test's failure for a key that replaced the one tested", async () => {
    const { api } = fakeAiProviders({
      connected: [{ provider: "openai" }],
      tested: { ok: false, model: "openai/gpt-5-mini", code: "model.failed" },
    });
    await shown(api);
    await testKey("OpenAI");
    await vi.waitFor(() => {
      expect(text()).toContain("Test failed");
    });

    await replaceKey("OpenAI", pastedKey);

    expect(text()).not.toContain("Test failed");
  });

  it("switches the organization's AI to Grasp's AI and back, saying what the month came to against its limit", async () => {
    const { api, asked } = fakeAiProviders({
      connected: [{ provider: "openai" }],
      graspAvailable: true,
    });
    await shown(api);
    expect(text()).toContain("Your AI runs on your own keys");

    await press(button("Switch to Grasp’s AI"));
    const onGrasp = text();
    await press(button("Switch to your own keys"));

    expect({
      asked,
      onGrasp: [
        onGrasp.includes("Your AI runs on Grasp’s AI"),
        onGrasp.includes("This month: $12.50 of $100.00."),
      ],
      back: text().includes("Your AI runs on your own keys"),
    }).toStrictEqual({
      asked: [
        ["source", "grasp"],
        ["source", "own"],
      ],
      onGrasp: [true, true],
      back: true,
    });
  });

  it("doesn't say AI can't answer for want of a provider while it runs on Grasp's AI", async () => {
    const { api } = fakeAiProviders({ graspAvailable: true });
    await shown(api);
    const onOwn = text().includes("so Grasp's AI can't answer yet");
    await press(button("Switch to Grasp’s AI"));

    expect({
      onOwn,
      onGrasp: text().includes("so Grasp's AI can't answer yet"),
      whatSwitchingLeaves: text().includes(
        "No provider of your own is connected"
      ),
    }).toStrictEqual({
      onOwn: true,
      onGrasp: false,
      whatSwitchingLeaves: true,
    });
  });

  it("says nothing of Grasp's AI where the deployment doesn't offer it", async () => {
    const { api } = fakeAiProviders();
    await shown(api);
    expect(text()).not.toContain("Grasp’s AI or your own keys");
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

    expect(text()).toContain("•••• 0000");
    expect(text()).toContain("GPT-5.4");
    expect(text()).toContain("GPT-5 mini");
    expect(document.querySelectorAll("input, select")).toHaveLength(0);
    // Only the info marks that say more: nothing that manages, tests or changes.
    expect(
      [...document.querySelectorAll("button")].filter(
        (each) => each.getAttribute("aria-label") !== "More about this setting"
      )
    ).toHaveLength(0);
  });
});
