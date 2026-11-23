import {
  aiProviders,
  compatibleModelNamePattern,
  featuredModels,
} from "@grasp-os/shared/ai-providers";
import type {
  AiModelChoice,
  AiModelChoiceNow,
  AiPlatformUse,
  AiProviderListed,
  AiProvidersListing,
  AiProviderStatus,
  AiSource,
  OrganizationProviderId,
} from "@grasp-os/shared/ai-providers";
import { failureText } from "@grasp-os/shared/errors";
import { ConnectApiKey } from "@grasp-os/ui/blocks/connect-api-key-01/connect-api-key-01";
import type { ConnectApiKeyLabels } from "@grasp-os/ui/blocks/connect-api-key-01/connect-api-key-01";
import { Badge } from "@grasp-os/ui/components/badge";
import type { BadgeVariant } from "@grasp-os/ui/components/badge";
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
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import type { FieldStatusValue } from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import { HoldButton } from "@grasp-os/ui/components/hold-button";
import { Input, SecretInput } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import { useAction } from "@grasp-os/ui/hooks/use-action";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GlobeIcon,
  Icon,
  PlusIcon,
  XIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n as active } from "@lingui/core";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { failureMessage } from "../chat/failure.ts";
import type { Session } from "../core.ts";
import { formatDollars } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import {
  FactRow,
  Failure,
  SettingRow,
  SettingsGroup,
  SettingsRows,
} from "./section.tsx";

// Settings › AI and spend, its first cards, as Damsko's settings pattern
// has it: one compact card per topic, rows inside, every control on one
// edge. The organization's own AI provider keys (core's `aiProviders`,
// @grasp-os/shared/ai-providers), which pay for its model calls: each a
// row with its mark, its name and its key's last four, how its calls go,
// and Manage: Test (one tiny call that says Works or why not), a new key,
// or deleting it with a hold. Another provider is added in a dialog of
// Damsko's Connect API key block, its key tested as it is added (an
// endpoint's once a model it serves is named). A key is pasted once into a
// secret field, goes straight to core and on to connect, which seals it,
// and is never back on the page. Then the default model and its
// fallbacks, the providers' main models first. The organization's own
// admins change it; Grasp staff only read it. While nothing is connected
// and nothing answers, the Providers card is the Connect API key block
// itself, where the first provider is connected in one step. Last, which
// provider handles Grasp's own AI features, which no setting here changes.

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
  ends: { display: "flex", alignItems: "center", gap: space[2] },
  inline: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
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
  fallback: { display: "flex", alignItems: "center", gap: space[1] },
  fields: { display: "grid", gap: space[4] },
  note: { marginBlock: space[2], marginInline: space.tableCellInline },
  uses: {
    display: "grid",
    gap: space[2],
    margin: 0,
    paddingInlineStart: space[5],
  },
});

type Change = (session: Session) => Promise<unknown>;

/** A note across a card's rows, in their inset. */
const RowNote = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.note)}>
    <Text color="muted" size="sm">
      {children}
    </Text>
  </div>
);

/**
 * A provider's mark: its first letter on a tile until the product's
 * marks are in (connections/brands.ts), the same in every row.
 */
const Mark = ({ name }: { name: string }) => (
  <BrandIcon decorative label={name} size="xs" />
);

/** How a provider's calls went lately: a word for its badge, and why where they fail. */
const useStatus = () => {
  const { t, i18n } = useLingui();
  return (
    status: AiProviderStatus | null
  ): { word: string; variant: BadgeVariant; why?: string } => {
    const unused = { word: t`Not used yet`, variant: "default" as const };
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
        variant: "success",
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
      variant: "destructive",
      ...(kind === undefined ? {} : { why: i18n._(kind) }),
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

/** `work`, refused with why in the person's words: core's refusal, or the provider's. */
const withReason = async (work: Promise<void>): Promise<void> => {
  try {
    await work;
  } catch (error) {
    throw new Error(failureText(error), { cause: error });
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
    { loadingLabel: t`Testing`, successLabel: t`Works`, errorLabel: t`Failed` }
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
  /** Test, one tiny call: its state lives with the row, so the row says how it went. */
  test: ReturnType<typeof useTest>;
  testModel: string | undefined | null;
  testFailure: string | undefined;
}) => {
  const { t } = useLingui();
  const formId = useId();
  const [key, setKey] = useState("");
  const [failure, setFailure] = useState<string>();
  const label = providerName(provider.provider, provider.label);
  const save = async (): Promise<void> => {
    setFailure(undefined);
    try {
      await onReplace(key);
    } catch (error) {
      setFailure(failureText(error));
      throw error;
    }
    setKey("");
    onOpenChange(false);
  };
  const remove = async (): Promise<void> => {
    setFailure(undefined);
    try {
      await onDelete();
    } catch (error) {
      setFailure(failureText(error));
      throw error;
    }
    onOpenChange(false);
  };
  // Why it can't be tested, or why its test failed: nothing while all is well.
  const testHelp =
    testModel === null
      ? t`Name a model it serves, under Models, to test it.`
      : testFailure;
  return (
    <Dialog
      onOpenChange={(next) => {
        setKey("");
        setFailure(undefined);
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div {...stylex.props(styles.fields)}>
            {/* Whether the key works, then a new one: a dialog's fields, not a card's rows. */}
            <Field orientation="responsive">
              <FieldContent>
                <FieldLabel>{t`Connection`}</FieldLabel>
                {testHelp === undefined ? null : (
                  <FieldDescription>{testHelp}</FieldDescription>
                )}
              </FieldContent>
              <Button
                disabled={testModel === null}
                errorLabel={test.labels.error}
                loadingLabel={test.labels.loading}
                onClick={() => {
                  void test.run();
                }}
                size="sm"
                status={test.status}
                successLabel={test.labels.success}
                variant="outline"
              >
                {t`Test`}
              </Button>
            </Field>
            <Form
              aria-label={t`Replace the key for ${label}`}
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Field>
                <FieldLabel>{t`New key`}</FieldLabel>
                <SecretInput
                  onValueChange={setKey}
                  placeholder={keyStarts[provider.provider]}
                  required
                  value={key}
                />
                <FieldError match="valueMissing">{t`Paste the new key.`}</FieldError>
              </Field>
              <Failure>{failure}</Failure>
            </Form>
          </div>
        </DialogBody>
        <DialogFooter>
          <HoldButton
            errorLabel={t`Not deleted`}
            labels={{
              holdTo: () => t`Hold to delete the key`,
              ask: () => t`Delete the ${label} key?`,
              confirm: t`Delete`,
              cancel: t`Cancel`,
            }}
            loadingLabel={t`Deleting`}
            onConfirm={remove}
            size="sm"
            variant="destructive"
          >
            {t`Delete key`}
          </HoldButton>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button
            errorLabel={t`Not saved`}
            form={formId}
            loadingLabel={t`Saving`}
            onClick={async () => {
              if (key === "") {
                return;
              }
              await save();
            }}
            size="sm"
            type="submit"
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
      <ItemMedia>
        <Mark name={label} />
      </ItemMedia>
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
          <Badge size="sm" variant={status.variant}>
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
                testFailure={testFailure}
                testModel={testModel}
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

/** The Connect API key block's own words, in the page's language. */
const useConnectLabels = (): ConnectApiKeyLabels => {
  const { t } = useLingui();
  return {
    address: t`Address`,
    addressMissing: t`Enter your endpoint's address.`,
    addressPlaceholder: "https://models.example.com/v1",
    addressWrong: t`Enter an address that starts with https://.`,
    change: t`Change`,
    connect: t`Connect`,
    connectName: (name) => t`Connect ${name}`,
    connected: t`Connected`,
    connecting: t`Connecting`,
    disconnect: t`Disconnect`,
    disconnectDetail: t`Nothing can use it any more, and its key is removed. Connecting again takes a new key.`,
    disconnectTitle: (name) => t`Disconnect ${name}?`,
    disconnecting: t`Disconnecting`,
    keep: t`Keep it`,
    key: t`Key`,
    keyLine: (last, region) =>
      region === undefined ? t`Key …${last}` : t`Key …${last} · ${region}`,
    keyMissing: t`Paste the key.`,
    keyNote: t`Only its last four characters are shown again.`,
    notConnected: t`Not connected`,
    notDisconnected: t`Could not disconnect`,
    replaceKey: t`Replace key`,
  };
};

/**
 * The providers to connect, as Damsko's Connect API key block takes them:
 * each by its name, where it runs, and how its keys start; an
 * OpenAI-compatible endpoint as the quiet line under them.
 */
const useOffers = (offered: AiProvidersListing["offered"]) => {
  const { t } = useLingui();
  return offered.map(({ provider, label }) => {
    const placeholder = keyStarts[provider];
    const { region } = aiProviders[provider];
    return {
      id: provider,
      name: providerName(provider, label),
      ...(placeholder === undefined ? {} : { placeholder }),
      ...(provider === "openai-compatible" ? { address: true } : {}),
      ...(region === "custom"
        ? {}
        : {
            region: {
              icon: <Icon icon={GlobeIcon} />,
              label: region === "eu" ? t`European Union` : t`United States`,
            },
          }),
    };
  });
};

/** The block's choice, as the provider it names. */
const providerOf = (
  offered: AiProvidersListing["offered"],
  id: string
): OrganizationProviderId =>
  offered.find((each) => each.provider === id)?.provider ?? "openai-compatible";

/**
 * Connecting the first provider: Damsko's Connect API key block, one card
 * of the providers as tiles, an OpenAI-compatible endpoint on one quiet
 * line under them, and the chosen one's key. `connect` adds and tests it,
 * and throws with the provider's reason, which the block says under the key.
 */
const FirstProvider = ({
  offered,
  connect,
}: {
  offered: AiProvidersListing["offered"];
  connect: Connect;
}) => {
  const { t } = useLingui();
  const labels = useConnectLabels();
  const providers = useOffers(offered);
  return (
    <ConnectApiKey
      labels={labels}
      onConnect={async ({ provider, key, address }) => {
        await withReason(
          connect(providerOf(offered, provider), key, address ?? "")
        );
      }}
      providers={providers}
      title={t`Providers`}
    />
  );
};

/**
 * Adding a provider once one is connected: Add a provider, then Damsko's
 * Connect API key block in a dialog, the providers not connected yet as
 * tiles, then the chosen one's key. `connect` adds and tests it, and
 * throws with the provider's reason, which the block says under the key;
 * once it is connected the dialog closes and the page reads again.
 */
const AddProvider = ({
  offered,
  connect,
}: {
  offered: AiProvidersListing["offered"];
  connect: Connect;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const labels = useConnectLabels();
  const providers = useOffers(offered);
  if (offered.length === 0) {
    return null;
  }
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="xs" variant="secondary">
          <Icon icon={PlusIcon} />
          {t`Add a provider`}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t`Add a provider`}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ConnectApiKey
            labels={labels}
            onConnect={async ({ provider, key, address }) => {
              await withReason(
                connect(providerOf(offered, provider), key, address ?? "")
              );
              setOpen(false);
            }}
            providers={providers}
            title={t`Choose a provider`}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
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
        <div {...stylex.props(styles.grow)}>
          <Input
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                add();
              }
            }}
            onValueChange={setName}
            size="sm"
            value={name}
          />
        </div>
        <Button disabled={!valid} onClick={add} size="sm" variant="outline">
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
  const [status, setStatus] = useState<FieldStatusValue>("idle");
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
    setStatus("loading");
    void (async () => {
      setStatus((await onChoose(next)) ? "success" : "error");
    })();
  };
  const chooseFallbacks = (next: string[]): void => {
    if (defaultModel !== null) {
      save({ defaultModel, fallbacks: next });
    }
  };
  const frozen = status === "loading" || defaultModel === null;
  const recommended = t`Recommended`;
  let defaultName = t`None: its provider was removed.`;
  if (choice === null) {
    defaultName = t`None yet`;
  } else if (defaultModel !== null) {
    defaultName = nameOf(defaultModel, providers);
  }
  return (
    <SettingsGroup title={t`Models`}>
      <SettingsRows>
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
          >
            <Combobox
              disabled={status === "loading"}
              items={modelItems(providers, named, [], recommended)}
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
          <SettingRow
            help={t`What chat, agents and workflows run on`}
            label={t`Default model`}
          >
            <Input readOnly size="sm" value={defaultName} />
          </SettingRow>
        )}
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
      </SettingsRows>
      {choice !== null && defaultModel === null && editable ? (
        <RowNote>
          {t`The default model's provider was removed. Choose a new default.`}
        </RowNote>
      ) : null}
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
                disabled={busy || (!onGrasp && !graspAi.available)}
                onClick={() => {
                  onSwitch(onGrasp ? "own" : "grasp");
                }}
                size="xs"
                variant="secondary"
              >
                {onGrasp ? t`Switch to your own keys` : t`Switch to Grasp’s AI`}
              </Button>
            ),
          }
        : {})}
      title={t`Grasp’s AI or your own keys`}
    >
      <SettingsRows>
        <FactRow
          {...(onGrasp ? { help: model } : {})}
          label={
            onGrasp
              ? t`Your AI runs on Grasp’s AI`
              : t`Your AI runs on your own keys`
          }
        >
          {onGrasp && graspAi.available && !graspAi.month.reached ? (
            <Text as="span" size="sm">
              {t`This month: ${spent} of ${limit}.`}
            </Text>
          ) : null}
        </FactRow>
      </SettingsRows>
      {onGrasp && !graspAi.available ? (
        <RowNote>
          {t`Grasp’s AI isn’t available here any more: AI is off until you switch to your own keys.`}
        </RowNote>
      ) : null}
      {onGrasp && graspAi.available && graspAi.month.reached ? (
        <RowNote>
          {t`This month’s limit of ${limit} is reached: AI is stopped until next month, or until you switch to your own keys.`}
        </RowNote>
      ) : null}
      {onGrasp && graspAi.available && providers.length === 0 ? (
        <RowNote>
          {t`No provider of your own is connected: switching to your own keys leaves AI off until you add one.`}
        </RowNote>
      ) : null}
    </SettingsGroup>
  );
};

/** One of Grasp's own features, and who handles it, in a sentence. */
const useUsageLine = () => {
  const { t } = useLingui();
  return ({ feature, provider }: AiPlatformUse): string => {
    const { whereItRuns } = provider;
    if (feature === "transcription") {
      return t`Grasp transcribes interviews with ${whereItRuns}, using Grasp's own key.`;
    }
    return t`Grasp reads the interview's questions aloud with ${whereItRuns}, using Grasp's own key.`;
  };
};

/** Who handles Grasp's own AI features, which no setting here changes. */
const PlatformUses = ({ uses }: { uses: readonly AiPlatformUse[] }) => {
  const { t } = useLingui();
  const usageLine = useUsageLine();
  return (
    <SettingsGroup
      description={t`These features always use Grasp's own provider keys, whichever providers you connect above.`}
      flush={false}
      title={t`Grasp's own AI features`}
    >
      <ul {...stylex.props(styles.uses)}>
        {uses.map((use) => (
          <li key={use.feature}>
            <Text as="span" size="sm">
              {usageLine(use)}
            </Text>
          </li>
        ))}
      </ul>
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

/** Settings › AI and spend's providers and models, on what core listed; `editable` for the organization's own admins. */
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
  const { providers, offered, choice, platform } = listing;
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
  // A provider, in one step: its key added, then tested with one tiny
  // call, and the page read again only after, so the card turns into the
  // connected row only once the key works. A key its provider refuses is
  // removed again: kept, it would stand as the organization's provider on
  // a key that doesn't work, and leave every chat, agent and workflow
  // failing on it, while the admin, told why under the field, pastes the
  // right one here. A custom endpoint is kept untested: it is tested once
  // a model it serves is named (testModelOf).
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
      {unanswered ? <Failure>{failure}</Failure> : null}
      {unanswered && editable ? (
        // Nothing answers yet: the card is where the first provider is
        // connected, for the organization's own admins.
        <FirstProvider connect={connect} offered={addable} />
      ) : null}
      {unanswered && !editable ? (
        <SettingsGroup flush={false} title={t`Providers`}>
          <Text color="muted" size="sm">
            {t`The organization's own admins connect its AI provider here.`}
          </Text>
        </SettingsGroup>
      ) : null}
      {unanswered ? null : (
        <SettingsGroup
          {...(editable
            ? { actions: <AddProvider connect={connect} offered={addable} /> }
            : {})}
          title={t`Providers`}
        >
          {failure === undefined ? null : <Failure>{failure}</Failure>}
          {providers.length > 0 ? (
            <ItemGroup aria-label={t`Connected providers`}>
              {providers.map((provider) => (
                <ProviderRow
                  editable={editable}
                  // A new key is a new row: no test of the key it replaced stays.
                  key={`${provider.provider}:${provider.mask}:${String(provider.updatedAt)}`}
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
              ))}
            </ItemGroup>
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
      {platform.length === 0 ? null : <PlatformUses uses={platform} />}
    </>
  );
};
