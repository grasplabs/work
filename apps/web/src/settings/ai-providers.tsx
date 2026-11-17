import {
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
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { failureMessage } from "../chat/failure.ts";
import type { Session } from "../core.ts";
import { formatDollars } from "../format.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIcon } from "../grasp/brand-icon/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import { Button, useAction } from "../grasp/button/index.ts";
import { Combobox } from "../grasp/combobox/index.ts";
import type { ComboboxItems } from "../grasp/combobox/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import {
  ChevronDown,
  ChevronUp,
  Cross,
  Icon,
  Key,
  Plus,
} from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { RadioGroup, RadioGroupItem } from "../grasp/radio-group/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  FactRow,
  RowAlert,
  SettingRow,
  SettingsRows,
} from "../grasp/setting-row/index.ts";
import type { SettingRowState } from "../grasp/setting-row/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// Settings › AI providers, as the library's Settings pattern has it: one
// compact card per topic, rows inside, every control on one edge and as
// wide as the others. The organization's own AI provider keys (core's
// `aiProviders`, @grasp-os/shared/ai-providers), which pay for its model
// calls: each a row with its mark, its name, its key as dots and its last
// four, how its calls go, and Test, one tiny call that says Works or why
// not. Its key is replaced or deleted in a small dialog. A key is pasted
// once into a password field, goes straight to core and on to connect,
// which seals it, and is never back on the page. Then the default model
// and its fallbacks, the providers' main models first. The organization's
// own admins change it; Grasp staff only read it.

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

/** Each provider's mark, where the Brand icons have it. */
const marks: Readonly<Record<OrganizationProviderId, Brand | undefined>> = {
  anthropic: "claude",
  openai: "chatgpt",
  mistral: undefined,
  openrouter: undefined,
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
  ends: { display: "flex", alignItems: "center", gap: grasp.space2 },
  named: { display: "inline-flex", alignItems: "center", gap: grasp.space2 },
  inline: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
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
  fallback: { display: "flex", alignItems: "center", gap: grasp.space1 },
});

type Change = (session: Session) => Promise<unknown>;

/** A provider's mark: its brand's, or a key where the Brand icons have none. */
const Mark = ({ provider }: { provider: OrganizationProviderId }) => {
  const brand = marks[provider];
  return brand === undefined ? (
    <Icon icon={Key} />
  ) : (
    // The mark alone, no tile round it (Ruben, 17 Nov 2026): without a
    // tile the mark is half its size's box, so `lg` draws it at 24px.
    <BrandIcon brand={brand} decorative size="lg" tile={false} />
  );
};

/** How a provider's calls went lately: a word for its badge, and why where they fail. */
const useStatus = () => {
  const { t, i18n } = useLingui();
  return (
    status: AiProviderStatus | null
  ): { word: string; tone: "success" | "danger" | "neutral"; why?: string } => {
    const unused = { word: t`Not used yet`, tone: "neutral" as const };
    if (status === null) {
      return unused;
    }
    const { lastOkAt, lastFailedAt, lastFailure } = status;
    if (
      lastOkAt !== null &&
      (lastFailedAt === null || lastOkAt >= lastFailedAt)
    ) {
      return { word: t`Working`, tone: "success" };
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
      tone: "danger",
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
        const short = Object.hasOwn(testFailures, outcome.code)
          ? testFailures[outcome.code]
          : undefined;
        throw new Error(
          short === undefined
            ? failureMessage(outcome.code, i18n)
            : i18n._(short)
        );
      }
    },
    { working: t`Testing`, done: t`Works`, failed: t`Failed` }
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
  const { label } = provider;
  const save = useAction(
    async () => {
      await onReplace(key);
      setKey("");
      onOpenChange(false);
    },
    { working: t`Saving`, done: t`Saved`, failed: t`Could not save` }
  );
  const remove = useAction(
    async () => {
      await onDelete();
      onOpenChange(false);
    },
    { working: t`Deleting`, done: t`Deleted`, failed: t`Could not delete` }
  );
  const failed = save.error ?? remove.error;
  return (
    <Dialog
      onOpenChange={(next) => {
        setKey("");
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>
          <span {...stylex.props(styles.named)}>
            <Mark provider={provider.provider} />
            {label}
          </span>
        </DialogTitle>
        <DialogBody>
          <SettingsRows>
            <SettingRow
              help={
                testModel === null
                  ? t`Name a model it serves, under Models, to test it.`
                  : testFailure
              }
              label={t`Connection`}
            >
              <Button disabled={testModel === null} size="sm" {...test.props}>
                {t`Test`}
              </Button>
            </SettingRow>
          </SettingsRows>
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
              <Alert tone="danger">{reasonOf(failed)}</Alert>
            )}
          </Form>
        </DialogBody>
        <DialogFooter>
          <Button
            hold
            holdLabels={{
              holdTo: () => t`Hold to delete the key`,
              ask: () => t`Delete the ${label} key?`,
              confirm: t`Delete`,
              cancel: t`Cancel`,
            }}
            variant="danger"
            {...remove.props}
          >
            {t`Delete key`}
          </Button>
          <DialogAction>{t`Cancel`}</DialogAction>
          <Button form={formId} type="submit" variant="ink" {...save.status}>
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
  const { label } = provider;
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
        <Mark provider={provider.provider} />
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
          <Badge size="sm" tone={status.tone}>
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

/** A provider to choose in the dialog: its mark, its name, and where it runs. */
const ProviderChoice = ({
  provider,
  label,
}: {
  provider: OrganizationProviderId;
  label: string;
}) => (
  <span {...stylex.props(styles.named)}>
    <Mark provider={provider} />
    {label}
  </span>
);

/** Adding a provider, in a dialog: which one, by its mark; a custom endpoint's address; its key. */
const AddProviderDialog = ({
  offered,
  onAdd,
}: {
  offered: AiProvidersListing["offered"];
  onAdd: (
    provider: OrganizationProviderId,
    key: string,
    baseUrl: string
  ) => Promise<void>;
}) => {
  const { t } = useLingui();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<OrganizationProviderId | undefined>();
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const close = (): void => {
    setOpen(false);
    setKey("");
    setBaseUrl("");
    setChosen(undefined);
  };
  const provider =
    offered.find((each) => each.provider === chosen) ?? offered[0];
  const add = useAction(
    async () => {
      if (provider !== undefined) {
        await onAdd(provider.provider, key, baseUrl);
        close();
      }
    },
    { working: t`Saving`, done: t`Saved`, failed: t`Could not save` }
  );
  if (provider === undefined) {
    return null;
  }
  const custom = provider.provider === "openai-compatible";
  return (
    <>
      <Button
        icon={Plus}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="ink"
      >
        {t`Add a provider`}
      </Button>
      <Dialog
        onOpenChange={(next) => {
          if (next) {
            setOpen(true);
          } else {
            close();
          }
        }}
        open={open}
      >
        <DialogContent closeLabel={t`Close`}>
          <DialogTitle>{t`Add a provider`}</DialogTitle>
          <DialogBody>
            <Form
              aria-label={t`Add a provider`}
              id={formId}
              onSubmit={(event) => {
                // Sent only once every field is right; sent here, not by the browser.
                event.preventDefault();
                void add.run();
              }}
            >
              <Field>
                <FieldLabel>{t`Provider`}</FieldLabel>
                <RadioGroup
                  onValueChange={(value) => {
                    setChosen(
                      offered.find((each) => each.provider === value)?.provider
                    );
                  }}
                  value={provider.provider}
                >
                  {offered.map((each) => (
                    <Field key={each.provider} orientation="horizontal">
                      <RadioGroupItem value={each.provider} />
                      <FieldContent>
                        <FieldLabel>
                          <ProviderChoice
                            label={each.label}
                            provider={each.provider}
                          />
                        </FieldLabel>
                        <FieldDescription>{each.whereItRuns}</FieldDescription>
                      </FieldContent>
                    </Field>
                  ))}
                </RadioGroup>
              </Field>
              {custom ? (
                <Field>
                  <FieldLabel>{t`Address`}</FieldLabel>
                  <Input
                    inputMode="url"
                    onValueChange={setBaseUrl}
                    placeholder="https://models.example.com/v1"
                    required
                    type="url"
                    value={baseUrl}
                  />
                  <FieldError match="valueMissing">{t`Enter your endpoint's address.`}</FieldError>
                  <FieldError match="typeMismatch">{t`Enter an address that starts with https://.`}</FieldError>
                </Field>
              ) : null}
              <Field>
                <FieldLabel>{t`Key`}</FieldLabel>
                <KeyInput
                  onValueChange={setKey}
                  provider={provider.provider}
                  value={key}
                />
                <FieldDescription>
                  {t`Only its last four characters are shown again.`}
                </FieldDescription>
                <FieldError match="valueMissing">{t`Paste the key.`}</FieldError>
              </Field>
              {add.error === null || add.error === undefined ? null : (
                <Alert tone="danger">{reasonOf(add.error)}</Alert>
              )}
            </Form>
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Cancel`}</DialogAction>
            <Button form={formId} type="submit" variant="ink" {...add.status}>
              {t`Add provider`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
            label: provider.label,
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
      help={t`As your endpoint names it, such as llama-3.3-70b.`}
      label={t`Your endpoint's model`}
    >
      {(field) => (
        <div {...stylex.props(styles.inline)}>
          <Input
            {...field}
            layout={styles.grow}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                add();
              }
            }}
            onValueChange={setName}
            size="sm"
            value={name}
          />
          <Button disabled={!valid} onClick={add} size="sm">
            {t`Add`}
          </Button>
        </div>
      )}
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
      help={t`Used in this order when the default's provider is down.`}
      label={t`Fallbacks`}
    >
      <ol aria-label={t`Fallbacks`} {...stylex.props(styles.list)}>
        {fallbacks.map((model, at) => {
          const name = nameOf(model, providers);
          return (
            <li key={model} {...stylex.props(styles.fallback)}>
              <div {...stylex.props(styles.grow)}>
                <Text element="span" size="sm">
                  {name}
                </Text>
              </div>
              {editable ? (
                <>
                  <Button
                    aria-label={t`Move ${name} up`}
                    disabled={frozen || at === 0}
                    icon={ChevronUp}
                    onClick={() => {
                      onChange(move(at, at - 1));
                    }}
                    size="xs"
                    variant="ghost"
                  />
                  <Button
                    aria-label={t`Move ${name} down`}
                    disabled={frozen || at === fallbacks.length - 1}
                    icon={ChevronDown}
                    onClick={() => {
                      onChange(move(at, at + 1));
                    }}
                    size="xs"
                    variant="ghost"
                  />
                  <Button
                    aria-label={t`Remove ${name} from the fallbacks`}
                    disabled={frozen}
                    icon={Cross}
                    onClick={() => {
                      onChange(fallbacks.filter((each) => each !== model));
                    }}
                    size="xs"
                    variant="ghost"
                  />
                </>
              ) : null}
            </li>
          );
        })}
      </ol>
    </FactRow>
  );
};

/** The words a row says of its save, translated. */
const useSaveWords = () => {
  const { t } = useLingui();
  return {
    failedLabel: t`Could not save. Your change is kept.`,
    retryLabel: t`Try again`,
    savedLabel: t`Saved`,
    savingLabel: t`Saving`,
  };
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
    <SectionCard density="compact" flush title={t`Models`}>
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
            label={t`Default model`}
            onRetry={() => {
              if (last !== undefined) {
                save(last);
              }
            }}
            status={status}
            {...words}
          >
            {(field) => (
              <Combobox
                {...field}
                disabled={status === "saving"}
                empty={t`No model has that name`}
                items={modelItems(providers, named, [], recommended)}
                layout={styles.control}
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
              />
            )}
          </SettingRow>
        ) : (
          <FactRow label={t`Default model`}>{defaultName}</FactRow>
        )}
        {choice !== null && defaultModel === null && editable ? (
          <RowAlert variant="attention">
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
          <SettingRow label={t`Add a fallback`}>
            {(field) => (
              <Combobox
                {...field}
                disabled={frozen}
                empty={t`No model has that name`}
                items={modelItems(providers, named, chosen, recommended)}
                layout={styles.control}
                onValueChange={(model) => {
                  if (model !== null && model !== "") {
                    chooseFallbacks([...fallbacks, model]);
                  }
                }}
                placeholder={t`Search models`}
                size="sm"
                value={null}
              />
            )}
          </SettingRow>
        ) : null}
      </SettingsRows>
    </SectionCard>
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
    <SectionCard
      {...(editable
        ? {
            actions: (
              <Button
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
      density="compact"
      flush
      title={t`Grasp’s AI or your own keys`}
    >
      <SettingsRows>
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
          <RowAlert variant="attention">
            {t`Grasp’s AI isn’t available here any more: AI is off until you switch to your own keys.`}
          </RowAlert>
        ) : null}
        {onGrasp && graspAi.available && graspAi.month.reached ? (
          <RowAlert variant="attention">
            {t`This month’s limit of ${limit} is reached: AI is stopped until next month, or until you switch to your own keys.`}
          </RowAlert>
        ) : null}
        {onGrasp && graspAi.available && providers.length === 0 ? (
          <RowAlert variant="neutral">
            {t`No provider of your own is connected: switching to your own keys leaves AI off until you add one.`}
          </RowAlert>
        ) : null}
      </SettingsRows>
    </SectionCard>
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
  const { t } = useLingui();
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
  const addKey = async (
    provider: OrganizationProviderId,
    key: string,
    baseUrl: string
  ): Promise<void> => {
    await changeOrThrow(async (session) =>
      provider === "openai-compatible"
        ? await session.aiProviders.add({ provider, key, baseUrl })
        : await session.aiProviders.add({ provider, key })
    );
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
      <SectionCard
        {...(editable && addable.length > 0
          ? {
              actions: <AddProviderDialog offered={addable} onAdd={addKey} />,
            }
          : {})}
        density="compact"
        flush
        title={t`Providers`}
      >
        {failure === undefined && !unanswered ? null : (
          <SettingsRows>
            {failure === undefined ? null : (
              <RowAlert variant="danger">{failure}</RowAlert>
            )}
            {unanswered ? (
              <RowAlert variant="attention">
                {t`No provider is connected, so Grasp's AI can't answer yet.`}
              </RowAlert>
            ) : null}
          </SettingsRows>
        )}
        {providers.length > 0 ? (
          <ItemGroup aria-label={t`Connected providers`} separated>
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
                  await addKey(provider.provider, key, provider.baseUrl ?? "");
                }}
                provider={provider}
                testModel={testModelOf(provider.provider, choice)}
              />
            ))}
          </ItemGroup>
        ) : null}
      </SectionCard>
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
