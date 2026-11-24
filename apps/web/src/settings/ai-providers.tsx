import {
  aiProviders,
  compatibleModelNamePattern,
  featuredModels,
} from "@grasp-os/shared/ai-providers";
import type {
  AiModelChoice,
  AiModelChoiceNow,
  AiProviderListed,
  AiProvidersListing,
  AiProviderStatus,
  AiSource,
  OrganizationProviderId,
} from "@grasp-os/shared/ai-providers";
import { failureText } from "@grasp-os/shared/errors";
import { ConnectApiKey } from "@grasp-os/ui/blocks/connect-api-key-01/connect-api-key-01";
import { Alert } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { Button } from "@grasp-os/ui/components/button";
import { Combobox, ComboboxEmpty } from "@grasp-os/ui/components/combobox";
import type { ComboboxItems } from "@grasp-os/ui/components/combobox";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import { HoldButton } from "@grasp-os/ui/components/hold-button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { useAction } from "@grasp-os/ui/hooks/use-action";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Icon,
  XIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n as active } from "@lingui/core";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { failureMessage } from "../chat/failure.ts";
import type { Session } from "../core.ts";
import { formatDollars } from "../format.ts";
import {
  BrandChatGpt,
  BrandClaude,
  BrandMistral,
  BrandOpenRouter,
} from "../frame/brands.ts";
import { EU, Flag, US } from "../frame/flag.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { CableIcon } from "../workflows/icons.ts";
import { SeparatedItems } from "../workflows/separated-items.tsx";
import { AddConnection } from "./add-connection/add-connection.tsx";
import { ReadOnlyRow } from "./read-only-row.tsx";
import { FactRow, RowAlert, SettingRow, SettingsGroup } from "./section.tsx";
import type { SettingRowState } from "./section.tsx";
import { useSaveWords } from "./workspace-name.tsx";

// Settings › AI providers, as the library's Settings pattern has it: one
// compact card per topic, rows inside, every control on one edge and as
// wide as the others. The organization's own AI provider keys (core's
// `aiProviders`, @grasp-os/shared/ai-providers), which pay for its model
// calls: each a row with its mark, its name, its key as dots and its last
// four, how its calls go, and Test, one tiny call that says Works or why
// not. Its key is replaced or deleted in a small dialog. Another provider is
// added in the library's Add connection sheet, its key tested as it is
// added (an endpoint's once a model it serves is named). A key is pasted
// once into a password field, goes straight to core and on to connect,
// which seals it, and is never back on the page. Then the default model
// and its fallbacks, the providers' main models first. The organization's
// own admins change it; Grasp staff only read it. While nothing is
// connected and nothing answers, the Providers card is where the first
// provider is connected: the library's Connect a service block, the
// providers as tiles, an OpenAI-compatible endpoint on one quiet line under
// them, and the key in the same card, added and tested in one step (Ruben,
// 19 Nov 2026).

/** The most fallbacks a choice may have, as core takes it. */
const fallbacksMax = 5;

/** The prefix of an OpenAI-compatible endpoint's models, which the organization names. */
const compatiblePrefix = "openai-compatible/";

/**
 * How each provider's keys start, shown in the key field so a person can
 * see they pasted the right kind; none where its keys have no fixed start
 * (Mistral's, a custom endpoint's). Core takes any key: this is a hint.
 */
const keyStarts: Readonly<Record<OrganizationProviderId, string | undefined>> =
  {
    anthropic: "sk-ant-…",
    openai: "sk-proj-…",
    mistral: undefined,
    openrouter: "sk-or-v1-…",
    "openai-compatible": undefined,
  };

/** Where each provider makes its keys, linked from the key step; none for an endpoint of one's own. */
const keyPages: Readonly<Record<OrganizationProviderId, string | undefined>> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  mistral: "https://console.mistral.ai/api-keys",
  openrouter: "https://openrouter.ai/settings/keys",
  "openai-compatible": undefined,
};

/** Each provider's mark, where there is one. */
const marks: Readonly<Record<OrganizationProviderId, IconData | undefined>> = {
  anthropic: BrandClaude,
  openai: BrandChatGpt,
  mistral: BrandMistral,
  openrouter: BrandOpenRouter,
  "openai-compatible": undefined,
};

/** How a provider's last call failed, in plain words, by the gateway's kind. */
const failureKinds: Readonly<Record<string, MessageDescriptor>> = {
  auth: msg`It refused the key.`,
  quota: msg`Its account is out of credit.`,
  rate_limited: msg`It was too busy and asked to wait.`,
  refused: msg`It refused the call.`,
  provider_down: msg`It didn't answer.`,
};

/** Why a test failed, said to the admin on this page, by core's code; else the chat's own words. */
const testFailures: Readonly<Record<string, MessageDescriptor>> = {
  "model.provider_key_failed": msg`It refused the key.`,
  "model.provider_unavailable": msg`It didn't answer.`,
  "model.rate_limited": msg`It was too busy and asked to wait.`,
};

const styles = stylex.create({
  // Every control fills the rows' shared control column.
  control: { width: "100%" },
  ends: { display: "flex", alignItems: "center", gap: space["2"] },
  named: { display: "inline-flex", alignItems: "center", gap: space["2"] },
  inline: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    width: "100%",
  },
  grow: { flexGrow: 1, minWidth: 0 },
  list: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  fallback: { display: "flex", alignItems: "center", gap: space["1"] },
});

type Change = (session: Session) => Promise<unknown>;

/**
 * A provider's mark, one size in every row of Settings (the library's
 * answer, 17 Nov 2026): its brand's mark alone at 20px, no tile; a plug
 * for a custom endpoint, which is no brand.
 */
const Mark = ({ provider }: { provider: OrganizationProviderId }) => {
  if (provider === "openai-compatible") {
    return <Icon icon={CableIcon} />;
  }
  const logo = marks[provider];
  return logo === undefined ? null : (
    <BrandIcon decorative logo={logo} name={provider} tile={false} />
  );
};

/** Whether `provider` shows a mark, so a row with none has no empty media. */
const hasMark = (provider: OrganizationProviderId): boolean =>
  provider === "openai-compatible" || marks[provider] !== undefined;

/** How a provider's calls went lately: a word for its badge, and why where they fail. */
const useStatus = () => {
  const { t, i18n } = useLingui();
  return (
    status: AiProviderStatus | null
  ): {
    word: string;
    tone: "success" | "destructive" | "default";
    why?: string;
  } => {
    const unused = { word: t`Not used yet`, tone: "default" as const };
    if (status === null) {
      return unused;
    }
    const { lastOkAt, lastFailedAt, lastFailure } = status;
    if (
      lastOkAt !== null &&
      (lastFailedAt === null || lastOkAt >= lastFailedAt)
    ) {
      return {
        word: t({ message: "Working", context: "a provider's key works" }),
        tone: "success",
      };
    }
    if (lastFailedAt === null) {
      return unused;
    }
    const kind =
      lastFailure !== null && Object.hasOwn(failureKinds, lastFailure)
        ? failureKinds[lastFailure]
        : undefined;
    return {
      word: t`Not working`,
      tone: "destructive",
      why: kind === undefined ? undefined : i18n._(kind),
    };
  };
};

/** The models chosen, the default first while there is one. */
const chosenOf = (choice: AiModelChoiceNow | null): string[] => {
  if (choice === null) {
    return [];
  }
  return choice.defaultModel === null
    ? choice.fallbacks
    : [choice.defaultModel, ...choice.fallbacks];
};

/** A model's name for people: the catalog's, or a custom endpoint's own. */
const nameOf = (
  model: string,
  providers: readonly AiProviderListed[]
): string => {
  for (const provider of providers) {
    const found = provider.models.find((each) => each.model === model);
    if (found !== undefined) {
      return found.name;
    }
  }
  return model.startsWith(compatiblePrefix)
    ? model.slice(compatiblePrefix.length)
    : model;
};

// A custom endpoint has no name of its own: core's label for it is English
// words, so the page says them in its own language.
const customEndpoint = msg`OpenAI-compatible endpoint`;

/** A provider's name, in the page's language for a custom endpoint. */
const providerName = (
  provider: OrganizationProviderId,
  label: string
): string =>
  provider === "openai-compatible" ? active._(customEndpoint) : label;

/** A key field: a password field, never shown, nor offered by the browser later; its placeholder how the provider's keys start. */
const KeyInput = ({
  provider,
  value,
  onValueChange,
}: {
  provider: OrganizationProviderId;
  value: string;
  onValueChange: (value: string) => void;
}) => (
  <Input
    autoComplete="off"
    onValueChange={onValueChange}
    placeholder={keyStarts[provider]}
    required
    secret
    spellCheck={false}
    type="password"
    value={value}
  />
);

/** Why a change failed, in the person's words. */
const reasonOf = (error: unknown): string => failureText(error);

/** `work`, refused with why in the person's words: core's refusal, or the provider's. */
const withReason = async (work: Promise<void>): Promise<void> => {
  try {
    await work;
  } catch (error) {
    throw new Error(reasonOf(error), { cause: error });
  }
};

/** Why a test failed, by core's code: this page's short words, else the chat's own. */
const testFailureText = (code: string, i18n: I18n): string => {
  const short = Object.hasOwn(testFailures, code)
    ? testFailures[code]
    : undefined;
  return short === undefined ? failureMessage(code, i18n) : i18n._(short);
};

/** Test: one tiny call; working, then Works, or Failed and why under the name. */
const useTest = (
  provider: OrganizationProviderId,
  model: string | undefined
) => {
  const { t, i18n } = useLingui();
  const core = useCore();
  const router = useRouter();
  return useAction(
    async () => {
      const outcome = await core.withSession(
        async (session) => await session.aiProviders.test(provider, model)
      );
      // How its calls go is read again: the test was one.
      void router.invalidate();
      if (!outcome.ok) {
        throw new Error(testFailureText(outcome.code, i18n));
      }
    },
    { loadingText: t`Testing`, successText: t`Works`, errorText: t`Failed` }
  );
};

/** Managing a provider: test it, replace its key, or delete it with a hold. */
const KeyDialog = ({
  provider,
  open,
  onOpenChange,
  onReplace,
  onDelete,
  test,
  testModel,
  testFailure,
}: {
  provider: AiProviderListed;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReplace: (key: string) => Promise<void>;
  onDelete: () => Promise<void>;
  /** Test, one tiny call: its button's state lives with the row, so the row says how it went. */
  test: ReturnType<typeof useTest>;
  testModel: string | undefined | null;
  testFailure: string | undefined;
}) => {
  const { t } = useLingui();
  const formId = useId();
  const [key, setKey] = useState("");
  const label = providerName(provider.provider, provider.label);
  const save = useAction(
    async () => {
      await onReplace(key);
      setKey("");
      onOpenChange(false);
    },
    { loadingText: t`Saving`, successText: t`Saved`, errorText: t`Not saved` }
  );
  const remove = useAction(
    async () => {
      await onDelete();
      onOpenChange(false);
    },
    {
      loadingText: t`Deleting`,
      successText: t`Deleted`,
      errorText: t`Not deleted`,
    }
  );
  const failed = save.error ?? remove.error;
  // Why it can't be tested, or why its test failed: nothing while all is well.
  const testHelp =
    testModel === null
      ? t`Name a model it serves, under Models, to test it.`
      : testFailure;
  return (
    <Dialog
      onOpenChange={(next) => {
        setKey("");
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <span {...stylex.props(styles.named)}>
              <Mark provider={provider.provider} />
              {label}
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          {/* Whether the key works, then a new one: a dialog's fields, not a card's rows. */}
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel>{t`Connection`}</FieldLabel>
              {testHelp === undefined ? null : (
                <FieldDescription>{testHelp}</FieldDescription>
              )}
            </FieldContent>
            <Button
              disabled={testModel === null}
              onClick={() => {
                void test.run();
              }}
              size="sm"
              status={test.status}
              variant="outline"
              {...test.labels}
            >
              {t`Test`}
            </Button>
          </Field>
          <Form
            aria-label={t`Replace the key for ${label}`}
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void save.run();
            }}
          >
            <Field>
              <FieldLabel>{t`New key`}</FieldLabel>
              <KeyInput
                onValueChange={setKey}
                provider={provider.provider}
                value={key}
              />
              <FieldError match="valueMissing">{t`Paste the new key.`}</FieldError>
            </Field>
            {failed === null || failed === undefined ? null : (
              <Alert variant="destructive">{reasonOf(failed)}</Alert>
            )}
          </Form>
        </DialogBody>
        <DialogFooter>
          <HoldButton
            errorText={t`Not deleted`}
            labels={{
              holdTo: () => t`Hold to delete the key`,
              ask: () => t`Delete the ${label} key?`,
              confirm: t`Delete`,
              cancel: t`Cancel`,
            }}
            loadingText={t`Deleting`}
            onConfirm={async () => {
              await remove.run();
            }}
            size="sm"
            successText={t`Deleted`}
            variant="destructive"
          >
            {t`Delete key`}
          </HoldButton>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button
            form={formId}
            size="sm"
            status={save.status}
            type="submit"
            {...save.labels}
          >
            {t`Replace key`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** One connected provider, on one line: its mark, its name and its key's last four, how its calls go, and Manage. */
const ProviderRow = ({
  provider,
  testModel,
  editable,
  onReplace,
  onDelete,
}: {
  provider: AiProviderListed;
  /** The model a test asks; null when there is none to ask yet (a custom endpoint before a model is named). */
  testModel: string | undefined | null;
  editable: boolean;
  onReplace: (key: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const statusOf = useStatus();
  const [managing, setManaging] = useState(false);
  const test = useTest(provider.provider, testModel ?? undefined);
  const label = providerName(provider.provider, provider.label);
  const last = provider.mask.replace("…", "");
  const status = statusOf(provider.status);
  const testFailure =
    test.error instanceof Error ? test.error.message : undefined;
  // A second line only where something is wrong.
  const trouble =
    testFailure === undefined ? status.why : t`Test failed: ${testFailure}`;
  return (
    <Item size="xs">
      {hasMark(provider.provider) ? (
        <ItemMedia align="center">
          <Mark provider={provider.provider} />
        </ItemMedia>
      ) : null}
      <ItemContent>
        <ItemTitle>
          {label}
          <ItemDetail>{`•••• ${last}`}</ItemDetail>
        </ItemTitle>
        {trouble === undefined ? null : (
          <ItemDescription>{trouble}</ItemDescription>
        )}
      </ItemContent>
      <ItemActions>
        <span {...stylex.props(styles.ends)}>
          <Badge size="sm" variant={status.tone}>
            {status.word}
          </Badge>
          {editable ? (
            <>
              <Button
                aria-label={t`Manage ${label}`}
                onClick={() => {
                  setManaging(true);
                }}
                size="sm"
                variant="ghost"
              >
                {t`Manage`}
              </Button>
              <KeyDialog
                onDelete={onDelete}
                onOpenChange={setManaging}
                onReplace={onReplace}
                open={managing}
                provider={provider}
                test={test}
                testModel={testModel}
                testFailure={testFailure}
              />
            </>
          ) : null}
        </span>
      </ItemActions>
    </Item>
  );
};

/** Adds a provider's key, with a custom endpoint's address; throws, with why, where it failed. */
type Connect = (
  provider: OrganizationProviderId,
  key: string,
  baseUrl: string
) => Promise<void>;

/**
 * Adding a provider once one is connected: the library's Add connection
 * sheet, the providers not connected yet as tiles, grouped by where they
 * run, then the chosen one's key, with the link to where its keys are made.
 * `connect` adds and tests it, and throws with the provider's reason, which
 * the sheet says under the key. The tiles stay as they were when the sheet
 * opened, so the provider just connected keeps its sheet open on its
 * connected step while the page reads again.
 */
const AddProviderSheet = ({
  offered,
  connect,
}: {
  offered: AiProvidersListing["offered"];
  connect: Connect;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(offered);
  if (!open && offered.length === 0) {
    return null;
  }
  const regions = [
    { id: "eu", label: t`European Union` },
    { id: "us", label: t`United States` },
    { id: "custom", label: t`Your own endpoint` },
  ] as const;
  const groups = regions
    .map(({ id, label }) => ({
      id,
      label,
      providers: shown
        .filter(({ provider }) => aiProviders[provider].region === id)
        .map(({ provider, label: name }) => {
          const brand = marks[provider];
          const keyHint = keyStarts[provider];
          const keyUrl = keyPages[provider];
          const [address] = Object.values(aiProviders[provider].baseUrls);
          return {
            id: provider,
            name: providerName(provider, name),
            host:
              address === undefined
                ? t`Wherever your endpoint runs`
                : new URL(address).host,
            ...(brand === undefined ? { icon: CableIcon } : { logo: brand }),
            ...(keyHint === undefined ? {} : { keyHint }),
            ...(keyUrl === undefined ? {} : { keyUrl }),
            ...(provider === "openai-compatible" ? { address: true } : {}),
          };
        }),
    }))
    .filter(({ providers }) => providers.length > 0);
  return (
    <AddConnection
      groups={groups}
      onConnect={async ({ provider, key, address }) => {
        // Connected since the sheet opened (its tile stays for the connected
        // step): adding it again would replace its working key, and remove
        // it when the new one is refused. Its key is replaced from its row.
        const addable = offered.find((each) => each.provider === provider);
        if (addable === undefined) {
          const tile = shown.find((each) => each.provider === provider);
          const name =
            tile === undefined
              ? provider
              : providerName(tile.provider, tile.label);
          throw new Error(t`${name} is connected already.`);
        }
        await withReason(connect(addable.provider, key, address ?? ""));
      }}
      onOpenChange={(next) => {
        if (next) {
          setShown(offered);
        }
        setOpen(next);
      }}
      open={open}
      words={{
        trigger: t`Add a provider`,
        title: t`Add a provider`,
      }}
    />
  );
};

/** A custom endpoint's models: those chosen, and those named here. */
const namedOf = (chosen: readonly string[], namedHere: readonly string[]) => [
  ...new Set(
    [...chosen, ...namedHere].filter((model) =>
      model.startsWith(compatiblePrefix)
    )
  ),
];

/**
 * The models to choose from: the connected providers' main ones first
 * (`featuredModels`, core's own list of what most organizations choose),
 * then every other, by provider. `except` are left out.
 */
const modelItems = (
  providers: readonly AiProviderListed[],
  named: readonly string[],
  except: readonly string[],
  recommendedLabel: string
): ComboboxItems => {
  const modelsOf = (provider: AiProviderListed) =>
    provider.provider === "openai-compatible"
      ? named.map((model) => ({
          model,
          name: model.slice(compatiblePrefix.length),
        }))
      : provider.models;
  const recommended = providers.flatMap((provider) =>
    featuredModels[provider.provider].flatMap((model) => {
      const found = provider.models.find((each) => each.model === model);
      return found === undefined || except.includes(model) ? [] : [found];
    })
  );
  const shown = new Set(recommended.map(({ model }) => model));
  const groups = providers.flatMap((provider) => {
    const left = modelsOf(provider).filter(
      ({ model }) => !except.includes(model) && !shown.has(model)
    );
    return left.length === 0
      ? []
      : [
          {
            type: "group" as const,
            label: providerName(provider.provider, provider.label),
            items: left.map(({ model, name }) => ({
              value: model,
              label: name,
            })),
          },
        ];
  });
  return recommended.length === 0
    ? groups
    : [
        {
          type: "group" as const,
          label: recommendedLabel,
          items: recommended.map(({ model, name }) => ({
            value: model,
            label: name,
          })),
        },
        ...groups,
      ];
};

/** Naming a model a custom endpoint serves, so it can be chosen. */
const NameModel = ({ onName }: { onName: (model: string) => void }) => {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const valid = compatibleModelNamePattern.test(name.trim());
  const add = (): void => {
    if (valid) {
      onName(`${compatiblePrefix}${name.trim()}`);
      setName("");
    }
  };
  return (
    <SettingRow
      help={t`As your endpoint names it, such as llama-3.3-70b`}
      label={t`Your endpoint's model`}
    >
      <div {...stylex.props(styles.inline)}>
        <Input
          style={styles.grow}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              add();
            }
          }}
          onValueChange={setName}
          size="sm"
          value={name}
        />
        <Button variant="outline" disabled={!valid} onClick={add} size="sm">
          {t`Add`}
        </Button>
      </div>
    </SettingRow>
  );
};

/** The fallbacks, in order, each moved or removed where they may change. */
const Fallbacks = ({
  fallbacks,
  providers,
  frozen,
  editable,
  onChange,
}: {
  fallbacks: readonly string[];
  providers: readonly AiProviderListed[];
  frozen: boolean;
  editable: boolean;
  onChange: (next: string[]) => void;
}) => {
  const { t } = useLingui();
  const move = (from: number, to: number): string[] => {
    const next = [...fallbacks];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) {
      next.splice(to, 0, moved);
    }
    return next;
  };
  return (
    <FactRow
      help={t`Used in this order when the default's provider is down`}
      label={t`Fallbacks`}
    >
      <ol aria-label={t`Fallbacks`} {...stylex.props(styles.list)}>
        {fallbacks.map((model, at) => {
          const name = nameOf(model, providers);
          return (
            <li key={model} {...stylex.props(styles.fallback)}>
              <div {...stylex.props(styles.grow)}>
                <Text as="span" size="sm">
                  {name}
                </Text>
              </div>
              {editable ? (
                <>
                  <Button
                    aria-label={t`Move ${name} up`}
                    disabled={frozen || at === 0}
                    onClick={() => {
                      onChange(move(at, at - 1));
                    }}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <Icon icon={ChevronUpIcon} />
                  </Button>
                  <Button
                    aria-label={t`Move ${name} down`}
                    disabled={frozen || at === fallbacks.length - 1}
                    onClick={() => {
                      onChange(move(at, at + 1));
                    }}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <Icon icon={ChevronDownIcon} />
                  </Button>
                  <Button
                    aria-label={t`Remove ${name} from the fallbacks`}
                    disabled={frozen}
                    onClick={() => {
                      onChange(fallbacks.filter((each) => each !== model));
                    }}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <Icon icon={XIcon} />
                  </Button>
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
    </FactRow>
  );
};

/** The default model and its fallbacks, in order, saved as they are chosen. */
const Models = ({
  providers,
  choice,
  editable,
  onChoose,
}: {
  providers: readonly AiProviderListed[];
  /** As core read it: never a model of a provider no longer connected. */
  choice: AiModelChoiceNow | null;
  editable: boolean;
  onChoose: (choice: AiModelChoice) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const words = useSaveWords();
  const [status, setStatus] = useState<SettingRowState>("idle");
  const [last, setLast] = useState<AiModelChoice>();
  // None once the provider it was of is removed: the fallbacks wait for
  // a new one, as a choice is saved with its default.
  const defaultModel = choice?.defaultModel ?? null;
  const chosen = chosenOf(choice);
  const [namedHere, setNamedHere] = useState<string[]>([]);
  const named = namedOf(chosen, namedHere);
  const custom = providers.some(
    ({ provider }) => provider === "openai-compatible"
  );
  const fallbacks = choice?.fallbacks ?? [];
  const save = (next: AiModelChoice): void => {
    setLast(next);
    setStatus("saving");
    void (async () => {
      setStatus((await onChoose(next)) ? "saved" : "failed");
    })();
  };
  const chooseFallbacks = (next: string[]): void => {
    if (defaultModel !== null) {
      save({ defaultModel, fallbacks: next });
    }
  };
  const frozen = status === "saving" || defaultModel === null;
  const recommended = t`Recommended`;
  let defaultName = t`None: its provider was removed.`;
  if (choice === null) {
    defaultName = t`None yet`;
  } else if (defaultModel !== null) {
    defaultName = nameOf(defaultModel, providers);
  }
  return (
    <SettingsGroup flush title={t`Models`}>
      <FieldGroup>
        {editable && custom ? (
          <NameModel
            onName={(model) => {
              setNamedHere((now) =>
                now.includes(model) ? now : [...now, model]
              );
            }}
          />
        ) : null}
        {editable ? (
          <SettingRow
            help={t`What chat, agents and workflows run on`}
            label={t`Default model`}
            onRetry={() => {
              if (last !== undefined) {
                save(last);
              }
            }}
            status={status}
            {...words}
          >
            <Combobox
              disabled={status === "saving"}
              items={modelItems(providers, named, [], recommended)}
              style={styles.control}
              onValueChange={(model) => {
                if (model !== null && model !== "") {
                  save({
                    defaultModel: model,
                    fallbacks: fallbacks.filter((each) => each !== model),
                  });
                }
              }}
              placeholder={t`Search models`}
              size="sm"
              value={defaultModel}
            >
              <ComboboxEmpty>{t`No model has that name`}</ComboboxEmpty>
            </Combobox>
          </SettingRow>
        ) : (
          <ReadOnlyRow
            help={t`What chat, agents and workflows run on`}
            label={t`Default model`}
            value={defaultName}
          />
        )}
        {choice !== null && defaultModel === null && editable ? (
          <RowAlert variant="warning">
            {t`The default model's provider was removed. Choose a new default.`}
          </RowAlert>
        ) : null}
        {fallbacks.length === 0 ? null : (
          <Fallbacks
            editable={editable}
            fallbacks={fallbacks}
            frozen={frozen}
            onChange={chooseFallbacks}
            providers={providers}
          />
        )}
        {editable && choice !== null && fallbacks.length < fallbacksMax ? (
          <SettingRow
            help={t`For when the default's provider is down`}
            label={t`Add a fallback`}
          >
            <Combobox
              disabled={frozen}
              items={modelItems(providers, named, chosen, recommended)}
              style={styles.control}
              onValueChange={(model) => {
                if (model !== null && model !== "") {
                  chooseFallbacks([...fallbacks, model]);
                }
              }}
              placeholder={t`Search models`}
              size="sm"
              value={null}
            >
              <ComboboxEmpty>{t`No model has that name`}</ComboboxEmpty>
            </Combobox>
          </SettingRow>
        ) : null}
      </FieldGroup>
    </SettingsGroup>
  );
};

/** The model a test of `provider` asks: its own test model, or for a custom endpoint the first of its models chosen; null when it has none yet. */
const testModelOf = (
  provider: OrganizationProviderId,
  choice: AiModelChoiceNow | null
): string | undefined | null => {
  if (provider !== "openai-compatible") {
    return undefined;
  }
  return (
    chosenOf(choice).find((model) => model.startsWith(compatiblePrefix)) ?? null
  );
};

/**
 * Whose AI the organization runs on: Grasp's AI, paid for by use up to a
 * month's limit, or its own provider keys; and for its own admins, the
 * way to switch. Shown where this deployment offers Grasp's AI, or the
 * organization is on it.
 */
const Source = ({
  listing,
  editable,
  busy,
  onSwitch,
}: {
  listing: AiProvidersListing;
  editable: boolean;
  busy: boolean;
  onSwitch: (source: AiSource) => void;
}) => {
  const { t } = useLingui();
  const { source, grasp: graspAi, providers } = listing;
  if (!graspAi.available && source !== "grasp") {
    return null;
  }
  const model = graspAi.model.name;
  const spent = formatDollars(graspAi.month.spentUsd);
  const limit = formatDollars(graspAi.month.limitUsd);
  const onGrasp = source === "grasp";
  return (
    <SettingsGroup
      {...(editable
        ? {
            actions: (
              <Button
                variant="outline"
                disabled={busy || (!onGrasp && !graspAi.available)}
                onClick={() => {
                  onSwitch(onGrasp ? "own" : "grasp");
                }}
                size="sm"
              >
                {onGrasp ? t`Switch to your own keys` : t`Switch to Grasp’s AI`}
              </Button>
            ),
          }
        : {})}
      flush
      title={t`Grasp’s AI or your own keys`}
    >
      <FieldGroup>
        <FactRow
          help={onGrasp ? model : undefined}
          label={
            onGrasp
              ? t`Your AI runs on Grasp’s AI`
              : t`Your AI runs on your own keys`
          }
        >
          {onGrasp && graspAi.available && !graspAi.month.reached
            ? t`This month: ${spent} of ${limit}.`
            : ""}
        </FactRow>
        {onGrasp && !graspAi.available ? (
          <RowAlert variant="warning">
            {t`Grasp’s AI isn’t available here any more: AI is off until you switch to your own keys.`}
          </RowAlert>
        ) : null}
        {onGrasp && graspAi.available && graspAi.month.reached ? (
          <RowAlert variant="warning">
            {t`This month’s limit of ${limit} is reached: AI is stopped until next month, or until you switch to your own keys.`}
          </RowAlert>
        ) : null}
        {onGrasp && graspAi.available && providers.length === 0 ? (
          <RowAlert variant="default">
            {t`No provider of your own is connected: switching to your own keys leaves AI off until you add one.`}
          </RowAlert>
        ) : null}
      </FieldGroup>
    </SettingsGroup>
  );
};

/** Adds `provider`'s key, with a custom endpoint's address. */
const addProvider = async (
  session: Session,
  provider: OrganizationProviderId,
  key: string,
  baseUrl: string
): Promise<void> => {
  await (provider === "openai-compatible"
    ? session.aiProviders.add({ provider, key, baseUrl })
    : session.aiProviders.add({ provider, key }));
};

/**
 * Connecting the first provider: Damsko's Connect API key block, one
 * card of the named providers as tiles, an OpenAI-compatible endpoint on
 * one quiet line under them, and the chosen one's key. `connect` adds and
 * tests it, and throws with the provider's reason, which the block says
 * under the key.
 */
const FirstProvider = ({
  offered,
  connect,
}: {
  offered: AiProvidersListing["offered"];
  connect: Connect;
}) => {
  const { t } = useLingui();
  const providers = offered.map(({ provider, label }) => {
    const logo = marks[provider];
    const placeholder = keyStarts[provider];
    const { region } = aiProviders[provider];
    if (region === "custom") {
      return {
        id: provider,
        name: providerName(provider, label),
        address: true,
        addressLabel: t`Use an OpenAI-compatible endpoint`,
      };
    }
    return {
      id: provider,
      name: providerName(provider, label),
      ...(logo === undefined ? {} : { logo }),
      ...(placeholder === undefined ? {} : { placeholder }),
      region:
        region === "eu"
          ? { icon: <Flag flag={EU} />, label: t`European Union` }
          : { icon: <Flag flag={US} />, label: t`United States` },
    };
  });
  return (
    <ConnectApiKey
      onConnect={async ({ provider, key, address }) => {
        const chosen =
          offered.find((each) => each.provider === provider)?.provider ??
          "openai-compatible";
        await withReason(connect(chosen, key, address ?? ""));
      }}
      labels={{
        address: t`Address`,
        addressMissing: t`Enter your endpoint's address.`,
        addressWrong: t`Enter an address that starts with https://.`,
        change: t`Change`,
        connect: t`Connect`,
        connectName: (name) => t`Connect ${name}`,
        connected: t`Connected`,
        connecting: t`Connecting`,
        key: t`Key`,
        keyLine: (last, region) =>
          region === undefined ? t`Key …${last}` : t`Key …${last} · ${region}`,
        keyMissing: t`Paste the key.`,
        keyNote: t`Only its last four characters are shown again.`,
        notConnected: t`Not connected`,
        replaceKey: t`Replace key`,
      }}
      providers={providers}
      title={t`Providers`}
    />
  );
};

/** Settings › AI providers, on what core listed; `editable` for the organization's own admins. */
export const AiProvidersSettings = ({
  listing,
  editable,
}: {
  listing: AiProvidersListing;
  editable: boolean;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const core = useCore();
  const { busy, failure, run } = useCoreAction();
  const { providers, offered, choice } = listing;
  /** A change, then the page read again; false where it failed, which the page says. */
  const change = async (action: Change): Promise<boolean> => {
    const done = await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await action(session);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
      return true;
    });
    return done === true;
  };
  /** A change from a dialog: it throws where it failed, so the dialog says why. */
  const changeOrThrow = async (action: Change): Promise<void> => {
    await core.withSession(async (session) => {
      await changeThenRefresh(
        async () => {
          await action(session);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const addKey: Connect = async (provider, key, baseUrl) => {
    await changeOrThrow(async (session) => {
      await addProvider(session, provider, key, baseUrl);
    });
  };
  // The first provider, in one step: its key added, then tested with one
  // tiny call, and the page read again only after, so the card turns into
  // the connected row only once the key works. A key its provider refuses
  // is removed again: kept, it would stand as the organization's provider,
  // close this card on a key that doesn't work, and leave every chat, agent
  // and workflow failing on it, while the admin, told why under the field,
  // pastes the right one here. A custom endpoint is kept untested: it is
  // tested once a model it serves is named (testModelOf).
  const connect: Connect = async (provider, key, baseUrl) => {
    await changeOrThrow(async (session) => {
      await addProvider(session, provider, key, baseUrl);
      if (provider === "openai-compatible") {
        return;
      }
      const outcome = await session.aiProviders.test(provider);
      if (!outcome.ok) {
        await session.aiProviders.remove(provider);
        throw new Error(testFailureText(outcome.code, i18n));
      }
    });
  };
  const addable = offered.filter(
    ({ provider }) => !providers.some((each) => each.provider === provider)
  );
  // On Grasp's AI, having no key of its own keeps nothing from answering.
  const unanswered = providers.length === 0 && listing.source !== "grasp";
  return (
    <>
      <Source
        busy={busy}
        editable={editable}
        listing={listing}
        onSwitch={(source) => {
          void change(async (session) => {
            await session.aiProviders.setSource(source);
          });
        }}
      />
      {unanswered && failure !== undefined ? (
        <Alert variant="destructive">{failure}</Alert>
      ) : null}
      {unanswered && editable ? (
        // Nothing answers yet: the card is where the first provider is
        // connected, for the organization's own admins.
        <FirstProvider connect={connect} offered={addable} />
      ) : null}
      {unanswered && !editable ? (
        <SettingsGroup title={t`Providers`}>
          <Text color="muted" size="sm">
            {t`The organization's own admins connect its AI provider here.`}
          </Text>
        </SettingsGroup>
      ) : null}
      {unanswered ? null : (
        <SettingsGroup
          {...(editable
            ? {
                actions: (
                  <AddProviderSheet connect={connect} offered={addable} />
                ),
              }
            : {})}
          flush
          title={t`Providers`}
        >
          {failure === undefined ? null : (
            <FieldGroup>
              <RowAlert variant="destructive">{failure}</RowAlert>
            </FieldGroup>
          )}
          {providers.length > 0 ? (
            <SeparatedItems
              aria-label={t`Connected providers`}
              rows={providers.map((provider) => ({
                // A new key is a new row: no test of the key it replaced stays.
                key: `${provider.provider}:${provider.mask}:${String(provider.updatedAt)}`,
                row: (
                  <ProviderRow
                    editable={editable}
                    onDelete={async () => {
                      await changeOrThrow(async (session) => {
                        await session.aiProviders.remove(provider.provider);
                      });
                    }}
                    onReplace={async (key) => {
                      await addKey(
                        provider.provider,
                        key,
                        provider.baseUrl ?? ""
                      );
                    }}
                    provider={provider}
                    testModel={testModelOf(provider.provider, choice)}
                  />
                ),
              }))}
            />
          ) : null}
        </SettingsGroup>
      )}
      {providers.length === 0 ? null : (
        <Models
          choice={choice}
          editable={editable}
          onChoose={async (next) =>
            await change(async (session) => {
              await session.aiProviders.setModels(next);
            })
          }
          providers={providers}
        />
      )}
    </>
  );
};
