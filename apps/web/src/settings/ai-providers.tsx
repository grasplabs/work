import { compatibleModelNamePattern } from "@grasp-os/shared/ai-providers";
import type {
  AiModelChoice,
  AiModelChoiceNow,
  AiPlatformUse,
  OrganizationProviderId,
  AiProviderListed,
  AiProvidersListing,
  AiProviderStatus,
  AiProviderTest,
  AiSource,
} from "@grasp-os/shared/ai-providers";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { failureMessage } from "../chat/failure.ts";
import type { Session } from "../core.ts";
import { formatDateTime, formatDollars } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogContent,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogFooter,
  DialogContent,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import {
  ChevronDown,
  ChevronUp,
  Cross,
  Edit,
  Key,
  More,
  Plus,
  Trash,
} from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
} from "../grasp/select/index.ts";
import type { SelectItems } from "../grasp/select/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { FactRow, RowAlert, SettingRow, SettingsRows } from "./section.tsx";

// Settings › AI providers: the organization's own AI provider keys, which
// pay for its model calls, and the models its calls use (core's
// `aiProviders`, @grasp-os/shared/ai-providers). A key is pasted once into a
// password field in a dialog, goes straight to core and on to connect,
// which seals it, and is never back on the page: only its mask (`…a3f2`).
// Each provider is a row: where it runs, its mask, how its calls went
// lately (from real calls through the gateway), and Test, one tiny call.
// Then the default model and its fallbacks, tried in order when a
// provider refuses a call before anything was billed. The organization's
// own admins change it; Grasp staff only read it. Every change saves at
// once and reads the page again. Last, which provider handles Grasp's own
// AI features (document conversion, transcription, speech) on Grasp's
// keys, whatever was connected, with nothing to switch.

/** The most fallbacks a choice may have, as core takes it. */
const fallbacksMax = 5;

/** The prefix of an OpenAI-compatible endpoint's models, which the organization names. */
const compatiblePrefix = "openai-compatible/";

/** How a provider's last call failed, in plain words, by the gateway's kind. */
const failureKinds: Readonly<Record<string, MessageDescriptor>> = {
  auth: msg`the provider refused the key`,
  rate_limited: msg`the provider was too busy and asked to wait`,
  refused: msg`the provider refused the call`,
  provider_down: msg`the provider didn't answer`,
};

/** How a provider's calls went lately: a word for its badge, and a line with when and why. */
const useStatus = () => {
  const { t, i18n } = useLingui();
  return (
    status: AiProviderStatus | null
  ): {
    word: string;
    tone: "success" | "danger" | "neutral";
    detail?: string;
  } => {
    const unused = { word: t`Not used yet`, tone: "neutral" as const };
    if (status === null) {
      return unused;
    }
    const { lastOkAt, lastFailedAt, lastFailure } = status;
    if (
      lastOkAt !== null &&
      (lastFailedAt === null || lastOkAt >= lastFailedAt)
    ) {
      const when = formatDateTime(lastOkAt);
      return {
        word: t`Working`,
        tone: "success",
        detail: t`Last used ${when}`,
      };
    }
    if (lastFailedAt === null) {
      return unused;
    }
    const when = formatDateTime(lastFailedAt);
    const kind =
      lastFailure !== null && Object.hasOwn(failureKinds, lastFailure)
        ? failureKinds[lastFailure]
        : undefined;
    const why = kind === undefined ? t`something went wrong` : i18n._(kind);
    return {
      word: t`Not working`,
      tone: "danger",
      detail: t`The last call, ${when}, failed because ${why}.`,
    };
  };
};

/** A model's name for people: the catalog's, or a custom endpoint's own. */
/** The models chosen, the default first while there is one. */
const chosenOf = (choice: AiModelChoiceNow | null): string[] => {
  if (choice === null) {
    return [];
  }
  return choice.defaultModel === null
    ? choice.fallbacks
    : [choice.defaultModel, ...choice.fallbacks];
};

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

type Change = (session: Session) => Promise<unknown>;

const styles = stylex.create({
  lines: { display: "flex", flexDirection: "column" },
  title: { display: "flex", alignItems: "center", gap: grasp.space2 },
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

/** How a test went, in a sentence. */
const TestOutcome = ({
  outcome,
  providers,
}: {
  outcome: AiProviderTest;
  providers: readonly AiProviderListed[];
}) => {
  const { t, i18n } = useLingui();
  const model = nameOf(outcome.model, providers);
  const why = outcome.ok ? "" : failureMessage(outcome.code, i18n);
  return (
    <output>
      <Text element="span" size="sm">
        {outcome.ok
          ? t`It works: ${model} answered the test.`
          : t`The test didn't work. ${model} didn't answer: ${why}`}
      </Text>
    </output>
  );
};

/** A key field: a password field, so the key is never shown, nor offered by the browser later. */
const KeyInput = ({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) => (
  <Input
    autoComplete="off"
    onValueChange={onValueChange}
    required
    secret
    spellCheck={false}
    type="password"
    value={value}
  />
);

/** A new key for `provider`, asked for in a dialog; the key goes once it is saved. */
const ReplaceKeyDialog = ({
  provider,
  open,
  onOpenChange,
  onReplace,
}: {
  provider: AiProviderListed;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReplace: (key: string) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const formId = useId();
  const [key, setKey] = useState("");
  const { label } = provider;
  return (
    <Dialog
      onOpenChange={(next) => {
        setKey("");
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Replace the key for ${label}`}</DialogTitle>
        <DialogBody>
          <Form
            aria-label={t`Replace the key for ${label}`}
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                if (await onReplace(key)) {
                  setKey("");
                  onOpenChange(false);
                }
              })();
            }}
          >
            <Field>
              <FieldLabel>{t`New key for ${label}`}</FieldLabel>
              <KeyInput onValueChange={setKey} value={key} />
              <FieldError match="valueMissing">{t`Paste the new key.`}</FieldError>
            </Field>
          </Form>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <Button form={formId} type="submit" variant="ink">
            {t`Save key`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** One connected provider, as a row: its status, where it runs and its key's mask, and Test; replacing and removing in its menu. */
const ProviderRow = ({
  provider,
  providers,
  testModel,
  editable,
  busy,
  tested,
  onTest,
  onReplace,
  onRemove,
}: {
  provider: AiProviderListed;
  providers: readonly AiProviderListed[];
  /** The model a test asks; none when there is none to ask yet (a custom endpoint before a model is named). */
  testModel: string | undefined | null;
  editable: boolean;
  busy: boolean;
  tested: AiProviderTest | undefined;
  onTest: () => void;
  onReplace: (key: string) => Promise<boolean>;
  onRemove: () => void;
}) => {
  const { t } = useLingui();
  const statusOf = useStatus();
  const [replacing, setReplacing] = useState(false);
  const { label, whereItRuns, mask } = provider;
  const status = statusOf(provider.status);
  return (
    <Item>
      <ItemMedia icon={Key} />
      <ItemContent>
        <ItemTitle>
          <span {...stylex.props(styles.title)}>
            {label}
            <Badge size="sm" tone={status.tone}>
              {status.word}
            </Badge>
          </span>
        </ItemTitle>
        <ItemDescription>
          <span {...stylex.props(styles.lines)}>
            <span>{t`Key ${mask} · ${whereItRuns}`}</span>
            {tested === undefined && status.detail !== undefined ? (
              <span>{status.detail}</span>
            ) : null}
            {tested === undefined ? null : (
              <TestOutcome outcome={tested} providers={providers} />
            )}
            {editable && testModel === null ? (
              <span>{t`Name a model this endpoint serves, then test it.`}</span>
            ) : null}
          </span>
        </ItemDescription>
      </ItemContent>
      {editable ? (
        <ItemActions>
          <>
            <Button
              aria-label={t`Test ${label}`}
              disabled={busy || testModel === null}
              onClick={onTest}
              size="sm"
            >
              {t`Test`}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                icon={More}
                aria-label={t`Actions for ${label}`}
                size="sm"
                variant="ghost"
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={busy}
                  icon={Edit}
                  onSelect={() => {
                    setReplacing(true);
                  }}
                >
                  {t`Replace key`}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="danger"
                  disabled={busy}
                  icon={Trash}
                  onSelect={onRemove}
                >
                  {t`Remove`}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ReplaceKeyDialog
              onOpenChange={setReplacing}
              onReplace={onReplace}
              open={replacing}
              provider={provider}
            />
          </>
        </ItemActions>
      ) : null}
    </Item>
  );
};

/** Adding a provider, in a dialog from the Providers card: which one, its key, and a custom endpoint's base URL. */
const AddProviderDialog = ({
  offered,
  onAdd,
}: {
  offered: AiProvidersListing["offered"];
  onAdd: (
    provider: OrganizationProviderId,
    key: string,
    baseUrl: string
  ) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<OrganizationProviderId | undefined>();
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const provider =
    offered.find((each) => each.provider === chosen) ?? offered[0];
  if (provider === undefined) {
    return null;
  }
  const { whereItRuns } = provider;
  const custom = provider.provider === "openai-compatible";
  const close = (): void => {
    setOpen(false);
    setKey("");
    setBaseUrl("");
    setChosen(undefined);
  };
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
                void (async () => {
                  if (await onAdd(provider.provider, key, baseUrl)) {
                    close();
                  }
                })();
              }}
            >
              <Field>
                <FieldLabel>{t`Provider`}</FieldLabel>
                <Select
                  items={offered.map((each) => ({
                    value: each.provider,
                    label: each.label,
                  }))}
                  onValueChange={(value) => {
                    setChosen(
                      offered.find((each) => each.provider === value)?.provider
                    );
                  }}
                  value={provider.provider}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
                <FieldDescription>{t`Runs at: ${whereItRuns}`}</FieldDescription>
              </Field>
              {custom ? (
                <Field>
                  <FieldLabel>{t`Base URL`}</FieldLabel>
                  <Input
                    inputMode="url"
                    onValueChange={setBaseUrl}
                    placeholder="https://"
                    required
                    type="url"
                    value={baseUrl}
                  />
                  <FieldDescription>
                    {t`Your endpoint's public HTTPS address, such as https://models.example.com/v1.`}
                  </FieldDescription>
                  <FieldError match="valueMissing">{t`Enter your endpoint's address.`}</FieldError>
                  <FieldError match="typeMismatch">{t`Enter an address that starts with https://.`}</FieldError>
                </Field>
              ) : null}
              <Field>
                <FieldLabel>{t`Key`}</FieldLabel>
                <KeyInput onValueChange={setKey} value={key} />
                <FieldDescription>
                  {t`From your provider's console. Stored sealed: only its last four characters show.`}
                </FieldDescription>
                <FieldError match="valueMissing">{t`Paste the key.`}</FieldError>
              </Field>
            </Form>
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Cancel`}</DialogAction>
            <Button form={formId} type="submit" variant="ink">
              {t`Save key`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

/** The models to choose from, by provider: each provider's catalog, and a custom endpoint's named ones. */
const modelItems = (
  providers: readonly AiProviderListed[],
  named: readonly string[],
  except: readonly string[]
): SelectItems =>
  providers.flatMap((provider) => {
    const models =
      provider.provider === "openai-compatible"
        ? named.map((model) => ({
            model,
            name: model.slice(compatiblePrefix.length),
          }))
        : provider.models;
    const left = models.filter(({ model }) => !except.includes(model));
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

/** Naming a model a custom endpoint serves, so it can be chosen, as a row. */
const NameModel = ({
  busy,
  onName,
}: {
  busy: boolean;
  onName: (model: string) => void;
}) => {
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
      label={t`A model your endpoint serves`}
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
            value={name}
          />
          <Button disabled={busy || !valid} onClick={add}>
            {t`Add`}
          </Button>
        </div>
      )}
    </SettingRow>
  );
};

/** The fallbacks, in order, each with moving and removing where they may change. */
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
      help={t`Tried in order when the default's provider refuses a call.`}
      label={t`Fallbacks`}
    >
      {fallbacks.length === 0 ? (
        t({ message: "None", context: "nothing set" })
      ) : (
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
                      disabled={frozen || at === 0}
                      icon={ChevronUp}
                      aria-label={t`Move ${name} up`}
                      onClick={() => {
                        onChange(move(at, at - 1));
                      }}
                      size="sm"
                      variant="ghost"
                    />
                    <Button
                      disabled={frozen || at === fallbacks.length - 1}
                      icon={ChevronDown}
                      aria-label={t`Move ${name} down`}
                      onClick={() => {
                        onChange(move(at, at + 1));
                      }}
                      size="sm"
                      variant="ghost"
                    />
                    <Button
                      disabled={frozen}
                      icon={Cross}
                      aria-label={t`Remove ${name} from the fallbacks`}
                      onClick={() => {
                        onChange(fallbacks.filter((each) => each !== model));
                      }}
                      size="sm"
                      variant="ghost"
                    />
                  </>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </FactRow>
  );
};

/** Adds a fallback; with none yet, this row alone stands for the fallbacks, so it says what they are. */
const AddFallback = ({
  items,
  frozen,
  only,
  onAdd,
}: {
  items: ReturnType<typeof modelItems>;
  frozen: boolean;
  only: boolean;
  onAdd: (model: string) => void;
}) => {
  const { t } = useLingui();
  return (
    <SettingRow
      help={
        only
          ? t`Tried in order when the default's provider refuses a call.`
          : undefined
      }
      label={t`Add a fallback`}
    >
      {(field) => (
        <Select
          disabled={frozen}
          items={items}
          onValueChange={(model) => {
            if (model !== null && model !== "") {
              onAdd(model);
            }
          }}
          value={null}
        >
          <SelectTrigger {...field}>
            <SelectValue placeholder={t`Choose a model`} />
          </SelectTrigger>
          <SelectContent />
        </Select>
      )}
    </SettingRow>
  );
};

/** The default model and its fallbacks, in order. */
const Models = ({
  providers,
  choice,
  editable,
  busy,
  onChoose,
}: {
  providers: readonly AiProviderListed[];
  /** As core read it: never a model of a provider no longer connected. */
  choice: AiModelChoiceNow | null;
  editable: boolean;
  busy: boolean;
  onChoose: (choice: AiModelChoice) => void;
}) => {
  const { t } = useLingui();
  // None once the provider it was of is removed: the fallbacks wait for
  // a new one, as a choice is saved with its default.
  const defaultModel = choice?.defaultModel ?? null;
  const chosen = chosenOf(choice);
  // A custom endpoint's models: those chosen now, as core read them (so a
  // choice another admin saved meanwhile is among them), and those named
  // here since.
  const [namedHere, setNamedHere] = useState<string[]>([]);
  const named = [
    ...new Set(
      [...chosen, ...namedHere].filter((model) =>
        model.startsWith(compatiblePrefix)
      )
    ),
  ];
  const custom = providers.some(
    ({ provider }) => provider === "openai-compatible"
  );
  const fallbacks = choice?.fallbacks ?? [];
  const chooseFallbacks = (next: string[]): void => {
    if (defaultModel !== null) {
      onChoose({ defaultModel, fallbacks: next });
    }
  };
  const frozen = busy || defaultModel === null;
  let defaultName = t`None: its provider was removed.`;
  if (choice === null) {
    defaultName = t`No model is chosen yet.`;
  } else if (defaultModel !== null) {
    defaultName = nameOf(defaultModel, providers);
  }
  return (
    <SectionCard flush title={t`Default and fallbacks`}>
      <SettingsRows>
        {editable && custom ? (
          <NameModel
            busy={busy}
            onName={(model) => {
              setNamedHere((now) =>
                now.includes(model) ? now : [...now, model]
              );
            }}
          />
        ) : null}
        {editable ? (
          <SettingRow
            help={t`What Grasp's AI uses for every call.`}
            label={t`Default model`}
          >
            {(field) => (
              <Select
                disabled={busy}
                items={modelItems(providers, named, [])}
                onValueChange={(model) => {
                  if (model !== null && model !== "") {
                    onChoose({
                      defaultModel: model,
                      fallbacks: fallbacks.filter((each) => each !== model),
                    });
                  }
                }}
                value={defaultModel}
              >
                <SelectTrigger {...field}>
                  <SelectValue placeholder={t`Choose a model`} />
                </SelectTrigger>
                <SelectContent />
              </Select>
            )}
          </SettingRow>
        ) : (
          <FactRow label={t`Default model`}>{defaultName}</FactRow>
        )}
        {choice !== null && defaultModel === null && editable ? (
          <RowAlert variant="attention">
            {t`The default model's provider was removed. Choose a new default model to change the fallbacks.`}
          </RowAlert>
        ) : null}
        {choice === null || (editable && fallbacks.length === 0) ? null : (
          <Fallbacks
            editable={editable}
            fallbacks={fallbacks}
            frozen={frozen}
            onChange={chooseFallbacks}
            providers={providers}
          />
        )}
        {editable && choice !== null && fallbacks.length < fallbacksMax ? (
          <AddFallback
            frozen={frozen}
            items={modelItems(providers, named, chosen)}
            onAdd={(model) => {
              chooseFallbacks([...fallbacks, model]);
            }}
            only={fallbacks.length === 0}
          />
        ) : null}
      </SettingsRows>
    </SectionCard>
  );
};

/** Removing a provider, once the admin confirms. */
const RemoveDialog = ({
  provider,
  onRemove,
  onClose,
}: {
  provider: AiProviderListed | null;
  onRemove: (provider: OrganizationProviderId) => Promise<void>;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const label = provider?.label ?? "";
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={provider !== null}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{t`Remove ${label}?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`Its key is deleted, and calls stop using it at once. Models of this provider are no longer used, even as a fallback.`}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction
            action={async () => {
              if (provider !== null) {
                await onRemove(provider.provider);
              }
            }}
            failedLabel={t`Could not remove`}
            variant="danger"
          >
            {t`Remove`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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

/** Who handles Grasp's own AI features, which no setting here changes: one fact a feature. */
const PlatformUses = ({ uses }: { uses: readonly AiPlatformUse[] }) => {
  const { t } = useLingui();
  const names: Record<AiPlatformUse["feature"], string> = {
    conversion: t`Uploaded documents`,
    transcription: t`Interview transcripts`,
    speech: t`Interview questions read aloud`,
  };
  return (
    <SectionCard
      description={t`Always on Grasp's own keys, whatever you connect above.`}
      flush
      title={t`Grasp's own AI features`}
    >
      <SettingsRows>
        {uses.map(({ feature, provider }) => (
          <FactRow
            key={feature}
            {...(feature === "conversion" && provider !== null
              ? {
                  help: t`Files in sensitive collections never leave this deployment.`,
                }
              : {})}
            label={names[feature]}
          >
            {provider === null ? t`On this deployment` : provider.whereItRuns}
          </FactRow>
        ))}
      </SettingsRows>
    </SectionCard>
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
  const { whereItRuns } = graspAi;
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
      flush
      title={t`Grasp’s AI or your own keys`}
    >
      <SettingsRows>
        <FactRow
          help={
            onGrasp
              ? t`${model}. Runs at: ${whereItRuns}`
              : t`The providers and models below.`
          }
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
  const { busy, failure, run } = useCoreAction();
  const [tests, setTests] = useState<
    Partial<Record<OrganizationProviderId, AiProviderTest>>
  >({});
  const [removing, setRemoving] = useState<AiProviderListed | null>(null);
  const { providers, offered, choice, platform } = listing;
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
              actions: (
                <AddProviderDialog
                  offered={addable}
                  onAdd={async (provider, key, baseUrl) =>
                    await change(async (session) =>
                      provider === "openai-compatible"
                        ? await session.aiProviders.add({
                            provider,
                            key,
                            baseUrl,
                          })
                        : await session.aiProviders.add({ provider, key })
                    )
                  }
                />
              ),
            }
          : {})}
        description={
          listing.source === "grasp"
            ? t`Your own keys, for when your AI runs on them. Stored sealed.`
            : t`Your organization's own keys pay for its model calls. Stored sealed.`
        }
        flush
        title={t`Providers`}
      >
        <SettingsRows>
          {failure === undefined ? null : (
            <RowAlert variant="danger">{failure}</RowAlert>
          )}
          {unanswered ? (
            <RowAlert variant="attention">
              {editable
                ? t`No AI provider is connected yet, so Grasp's AI features can't answer. Add one above.`
                : t`No AI provider is connected yet, so Grasp's AI features can't answer.`}
            </RowAlert>
          ) : null}
        </SettingsRows>
        {providers.length > 0 ? (
          <ItemGroup aria-label={t`Connected providers`} separated>
            {providers.map((provider) => (
              <ProviderRow
                busy={busy}
                editable={editable}
                key={provider.provider}
                onRemove={() => {
                  setRemoving(provider);
                }}
                onReplace={async (key) => {
                  const replaced = await change(async (session) =>
                    provider.provider === "openai-compatible"
                      ? await session.aiProviders.add({
                          provider: "openai-compatible",
                          key,
                          baseUrl: provider.baseUrl ?? "",
                        })
                      : await session.aiProviders.add({
                          provider: provider.provider,
                          key,
                        })
                  );
                  // A test of the key it replaced says nothing of this one.
                  if (replaced) {
                    setTests((now) => ({
                      ...now,
                      [provider.provider]: undefined,
                    }));
                  }
                  return replaced;
                }}
                onTest={() => {
                  void change(async (session) => {
                    const outcome = await session.aiProviders.test(
                      provider.provider,
                      testModelOf(provider.provider, choice) ?? undefined
                    );
                    setTests((now) => ({
                      ...now,
                      [provider.provider]: outcome,
                    }));
                  });
                }}
                provider={provider}
                providers={providers}
                tested={tests[provider.provider]}
                testModel={testModelOf(provider.provider, choice)}
              />
            ))}
          </ItemGroup>
        ) : null}
      </SectionCard>
      {providers.length === 0 ? null : (
        <Models
          busy={busy}
          choice={choice}
          editable={editable}
          onChoose={(next) => {
            void change(async (session) => {
              await session.aiProviders.setModels(next);
            });
          }}
          providers={providers}
        />
      )}
      <RemoveDialog
        onClose={() => {
          setRemoving(null);
        }}
        onRemove={async (provider) => {
          if (
            await change(async (session) => {
              await session.aiProviders.remove(provider);
            })
          ) {
            setTests((now) => ({ ...now, [provider]: undefined }));
            return;
          }
          throw new Error("not removed");
        }}
        provider={removing}
      />
      {platform.length === 0 ? null : <PlatformUses uses={platform} />}
    </>
  );
};
