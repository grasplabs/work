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
} from "@grasp-os/shared/ai-providers";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { failureMessage } from "../chat/failure.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import {
  SettingsBody,
  SettingsRow,
  SettingsSection,
} from "./settings-parts.tsx";

// Settings › AI providers: the organization's own AI provider keys, which
// pay for its model calls, and the models its calls use (core's
// `aiProviders`, @grasp-os/shared/ai-providers). A key is pasted once into a
// password field, goes straight to core and on to connect, which seals it,
// and is cleared from the field once saved: the page never has it back,
// only its mask (`…a3f2`). Each provider says where it runs, as the
// shared list says it, and how its calls went lately, from real calls
// through the gateway; "Test" makes one tiny call. Then the default model
// and its fallbacks, tried in order when a provider refuses a call before
// anything was billed. The organization's own admins change it; Grasp
// staff only read it. Every change saves at once and reads the page again.
// Last, which provider handles Grasp's own AI features (document
// conversion, transcription, speech) on Grasp's keys, whatever was
// connected: said plainly, with nothing to switch, so the admins know
// where that data goes.

/** The most fallbacks a choice may have, as core takes it. */
const fallbacksMax = 5;

/** The prefix of an OpenAI-compatible endpoint's models, which the organization names. */
const compatiblePrefix = "openai-compatible/";

/** How a provider's last call failed, in plain words, by the ledger's kind. */
const failureKinds: Readonly<Record<string, MessageDescriptor>> = {
  auth: msg`the provider refused the key`,
  rate_limited: msg`the provider was too busy and asked to wait`,
  refused: msg`the provider refused the call`,
  provider_down: msg`the provider didn't answer`,
};

/** How a provider's calls went lately, in a sentence. */
const useStatusLine = () => {
  const { t, i18n } = useLingui();
  return (status: AiProviderStatus | null): string => {
    if (status === null) {
      return t`Not used yet.`;
    }
    const { lastOkAt, lastFailedAt, lastFailure } = status;
    if (
      lastOkAt !== null &&
      (lastFailedAt === null || lastOkAt >= lastFailedAt)
    ) {
      const when = formatDateTime(lastOkAt);
      return t`Working. Last used ${when}.`;
    }
    if (lastFailedAt === null) {
      return t`Not used yet.`;
    }
    const when = formatDateTime(lastFailedAt);
    const kind =
      lastFailure !== null && Object.hasOwn(failureKinds, lastFailure)
        ? failureKinds[lastFailure]
        : undefined;
    const why = kind === undefined ? t`something went wrong` : i18n._(kind);
    return t`Not working: the last call, ${when}, failed because ${why}.`;
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

/** A key field: a password field, so the key is never shown, nor offered by the browser later. */
const KeyField = ({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) => (
  <Input
    autoComplete="off"
    disabled={disabled}
    id={id}
    onChange={(event) => {
      onChange(event.target.value);
    }}
    spellCheck={false}
    type="password"
    value={value}
  />
);

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
  if (outcome.ok) {
    return (
      <output className="text-status-agreed">
        {t`It works: ${model} answered the test.`}
      </output>
    );
  }
  const why = failureMessage(outcome.code, i18n);
  return (
    <output className="text-destructive">
      {t`The test didn't work. ${model} didn't answer: ${why}`}
    </output>
  );
};

/** One connected provider: where it runs, its key's mask, how its calls went, and what an admin can do with it. */
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
  const statusLine = useStatusLine();
  const keyId = useId();
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState("");
  const { label, whereItRuns, mask } = provider;
  return (
    <li className="flex flex-col gap-3 border-t px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
          <span className="font-medium">{label}</span>
          <span className="text-muted-foreground">
            {t`Runs at: ${whereItRuns}`}
          </span>
          <span className="text-muted-foreground">
            <Trans>
              Key: <span className="font-mono">{mask}</span>
            </Trans>
          </span>
          <span>{statusLine(provider.status)}</span>
        </div>
        {editable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              aria-label={t`Test ${label}`}
              disabled={busy || testModel === null}
              onClick={onTest}
              size="sm"
              variant="outline"
            >
              <Trans>Test</Trans>
            </Button>
            <Button
              aria-label={t`Replace the key for ${label}`}
              disabled={busy}
              onClick={() => {
                setReplacing(!replacing);
                setKey("");
              }}
              size="sm"
              variant="outline"
            >
              <Trans>Replace key</Trans>
            </Button>
            <Button
              aria-label={t`Remove ${label}`}
              disabled={busy}
              onClick={onRemove}
              size="sm"
              variant="outline"
            >
              <Trans>Remove</Trans>
            </Button>
          </div>
        ) : null}
      </div>
      {editable && testModel === null ? (
        <p className="text-muted-foreground">
          <Trans>
            Name a model this endpoint serves below and choose it, then test it.
          </Trans>
        </p>
      ) : null}
      {tested === undefined ? null : (
        <TestOutcome outcome={tested} providers={providers} />
      )}
      {replacing ? (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              if (await onReplace(key)) {
                setKey("");
                setReplacing(false);
              }
            })();
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor={keyId}>{t`New key for ${label}`}</label>
            <KeyField
              disabled={busy}
              id={keyId}
              onChange={setKey}
              value={key}
            />
          </div>
          <Button disabled={busy || key.trim() === ""} size="sm" type="submit">
            <Trans>Save key</Trans>
          </Button>
        </form>
      ) : null}
    </li>
  );
};

/** Adding a provider: which one, its key, and a custom endpoint's base URL. */
const AddProvider = ({
  offered,
  busy,
  onAdd,
}: {
  offered: AiProvidersListing["offered"];
  busy: boolean;
  onAdd: (
    provider: OrganizationProviderId,
    key: string,
    baseUrl: string
  ) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const providerId = useId();
  const keyId = useId();
  const baseUrlId = useId();
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
  const ready = key.trim() !== "" && (!custom || baseUrl.trim() !== "");
  return (
    <SettingsSection
      description={t`Paste the key from your provider's console. It is stored sealed and never shown again: only its first and last characters.`}
      title={t`Add a provider`}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            if (await onAdd(provider.provider, key, baseUrl)) {
              setKey("");
              setBaseUrl("");
              setChosen(undefined);
            }
          })();
        }}
      >
        <SettingsRow
          description={t`Runs at: ${whereItRuns}`}
          htmlFor={providerId}
          label={t`Provider`}
        >
          <NativeSelect
            disabled={busy}
            id={providerId}
            onChange={(event) => {
              const next = offered.find(
                (each) => each.provider === event.target.value
              );
              setChosen(next?.provider);
            }}
            size="sm"
            value={provider.provider}
          >
            {offered.map((each) => (
              <NativeSelectOption key={each.provider} value={each.provider}>
                {each.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </SettingsRow>
        {custom ? (
          <SettingsRow
            description={t`Your endpoint's public HTTPS address, such as https://models.example.com/v1.`}
            htmlFor={baseUrlId}
            label={t`Base URL`}
          >
            <Input
              disabled={busy}
              id={baseUrlId}
              inputMode="url"
              onChange={(event) => {
                setBaseUrl(event.target.value);
              }}
              placeholder="https://"
              type="url"
              value={baseUrl}
            />
          </SettingsRow>
        ) : null}
        <SettingsRow htmlFor={keyId} label={t`Key`}>
          <KeyField disabled={busy} id={keyId} onChange={setKey} value={key} />
        </SettingsRow>
        <div className="flex justify-end border-t px-5 py-4">
          <Button disabled={busy || !ready} size="sm" type="submit">
            <Trans>Save key</Trans>
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
};

/** The models to choose from, by provider: each provider's catalog, and a custom endpoint's named ones. */
const ModelOptions = ({
  providers,
  named,
  except,
}: {
  providers: readonly AiProviderListed[];
  named: readonly string[];
  except: readonly string[];
}) =>
  providers.map((provider) => {
    const models =
      provider.provider === "openai-compatible"
        ? named.map((model) => ({
            model,
            name: model.slice(compatiblePrefix.length),
          }))
        : provider.models;
    const left = models.filter(({ model }) => !except.includes(model));
    return left.length === 0 ? null : (
      <NativeSelectOptGroup key={provider.provider} label={provider.label}>
        {left.map(({ model, name }) => (
          <NativeSelectOption key={model} value={model}>
            {name}
          </NativeSelectOption>
        ))}
      </NativeSelectOptGroup>
    );
  });

/** Naming a model a custom endpoint serves, so it can be chosen. */
const NameModel = ({
  busy,
  onName,
}: {
  busy: boolean;
  onName: (model: string) => void;
}) => {
  const { t } = useLingui();
  const id = useId();
  const [name, setName] = useState("");
  const valid = compatibleModelNamePattern.test(name.trim());
  return (
    <SettingsRow
      description={t`As your endpoint names it, such as llama-3.3-70b.`}
      htmlFor={id}
      label={t`A model your endpoint serves`}
    >
      <form
        className="flex w-full gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            onName(`${compatiblePrefix}${name.trim()}`);
            setName("");
          }
        }}
      >
        <Input
          disabled={busy}
          id={id}
          onChange={(event) => {
            setName(event.target.value);
          }}
          value={name}
        />
        <Button disabled={busy || !valid} size="sm" type="submit">
          <Trans>Add</Trans>
        </Button>
      </form>
    </SettingsRow>
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
  const defaultId = useId();
  const fallbackId = useId();
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
  const fallbacksFrozen = busy || defaultModel === null;
  const move = (from: number, to: number): string[] => {
    const next = [...fallbacks];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) {
      next.splice(to, 0, moved);
    }
    return next;
  };
  const description = t`Grasp's AI uses the default model. When its provider refuses a call before anything was billed, the fallbacks are tried in order.`;
  if (!editable) {
    return (
      <SettingsSection description={description} title={t`Models`}>
        <SettingsBody>
          {choice === null ? (
            <p className="text-muted-foreground">
              <Trans>No model is chosen yet.</Trans>
            </p>
          ) : (
            <dl className="flex flex-col gap-2">
              <div className="flex flex-col">
                <dt className="text-muted-foreground">
                  <Trans>Default model</Trans>
                </dt>
                <dd>
                  {defaultModel === null ? (
                    <Trans>None: its provider was removed.</Trans>
                  ) : (
                    nameOf(defaultModel, providers)
                  )}
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-muted-foreground">
                  <Trans>Fallbacks</Trans>
                </dt>
                <dd>
                  {fallbacks.length === 0 ? (
                    <Trans>None</Trans>
                  ) : (
                    <ol className="list-decimal pl-5">
                      {fallbacks.map((model) => (
                        <li key={model}>{nameOf(model, providers)}</li>
                      ))}
                    </ol>
                  )}
                </dd>
              </div>
            </dl>
          )}
        </SettingsBody>
      </SettingsSection>
    );
  }
  return (
    <SettingsSection description={description} title={t`Models`}>
      {custom ? (
        <NameModel
          busy={busy}
          onName={(model) => {
            setNamedHere((now) =>
              now.includes(model) ? now : [...now, model]
            );
          }}
        />
      ) : null}
      <SettingsRow htmlFor={defaultId} label={t`Default model`}>
        <NativeSelect
          disabled={busy}
          id={defaultId}
          onChange={(event) => {
            const model = event.target.value;
            if (model !== "") {
              onChoose({
                defaultModel: model,
                fallbacks: fallbacks.filter((each) => each !== model),
              });
            }
          }}
          size="sm"
          value={defaultModel ?? ""}
        >
          {defaultModel === null ? (
            <NativeSelectOption value="">{t`Choose a model`}</NativeSelectOption>
          ) : null}
          <ModelOptions except={[]} named={named} providers={providers} />
        </NativeSelect>
      </SettingsRow>
      {choice !== null && defaultModel === null ? (
        <p className="text-muted-foreground px-5 pb-4">
          <Trans>
            The default model&apos;s provider was removed. Choose a new default
            model to change the fallbacks.
          </Trans>
        </p>
      ) : null}
      {choice === null ? null : (
        <div className="flex flex-col gap-3 border-t px-5 py-4">
          <span>
            <Trans>Fallbacks, in order</Trans>
          </span>
          {fallbacks.length === 0 ? (
            <p className="text-muted-foreground">
              <Trans>None yet.</Trans>
            </p>
          ) : (
            <ol aria-label={t`Fallbacks`} className="flex flex-col gap-1">
              {fallbacks.map((model, at) => {
                const name = nameOf(model, providers);
                return (
                  <li className="flex items-center gap-2" key={model}>
                    <span className="text-muted-foreground w-5">{at + 1}.</span>
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <Button
                      aria-label={t`Move ${name} up`}
                      disabled={fallbacksFrozen || at === 0}
                      onClick={() => {
                        chooseFallbacks(move(at, at - 1));
                      }}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <ArrowUpIcon />
                    </Button>
                    <Button
                      aria-label={t`Move ${name} down`}
                      disabled={fallbacksFrozen || at === fallbacks.length - 1}
                      onClick={() => {
                        chooseFallbacks(move(at, at + 1));
                      }}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <ArrowDownIcon />
                    </Button>
                    <Button
                      aria-label={t`Remove ${name} from the fallbacks`}
                      disabled={fallbacksFrozen}
                      onClick={() => {
                        chooseFallbacks(
                          fallbacks.filter((each) => each !== model)
                        );
                      }}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <XIcon />
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
          {fallbacks.length < fallbacksMax ? (
            <div className="flex flex-col gap-1 sm:w-64 sm:self-end">
              <label htmlFor={fallbackId}>{t`Add a fallback`}</label>
              <NativeSelect
                disabled={fallbacksFrozen}
                id={fallbackId}
                onChange={(event) => {
                  const model = event.target.value;
                  if (model !== "") {
                    chooseFallbacks([...fallbacks, model]);
                  }
                }}
                size="sm"
                value=""
              >
                <NativeSelectOption value="">
                  {t`Choose a model`}
                </NativeSelectOption>
                <ModelOptions
                  except={chosen}
                  named={named}
                  providers={providers}
                />
              </NativeSelect>
            </div>
          ) : null}
        </div>
      )}
    </SettingsSection>
  );
};

/** Removing a provider, once the admin confirms. */
const RemoveDialog = ({
  provider,
  busy,
  onRemove,
  onClose,
}: {
  provider: AiProviderListed | null;
  busy: boolean;
  onRemove: (provider: OrganizationProviderId) => void;
  onClose: () => void;
}) => {
  const label = provider?.label ?? "";
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={provider !== null}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Remove {label}?</Trans>
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          <Trans>
            Its key is deleted, and calls stop using it at once. Models of this
            provider are no longer used, even as a fallback.
          </Trans>
        </p>
        <DialogFooter showCloseButton>
          <Button
            disabled={busy || provider === null}
            onClick={() => {
              if (provider !== null) {
                onRemove(provider.provider);
              }
            }}
            variant="destructive"
          >
            <Trans>Remove</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

/** One of Grasp's own features, and who handles it, in a sentence. */
const useUsageLine = () => {
  const { t } = useLingui();
  return ({ feature, provider, off }: AiPlatformUse): string => {
    if (provider === null) {
      return t`Grasp converts uploaded documents on this deployment: nothing is sent out.`;
    }
    const { whereItRuns } = provider;
    if (off) {
      return feature === "transcription"
        ? t`Interviews aren't transcribed: this deployment keeps everything in the EU, and ${whereItRuns} isn't.`
        : t`The interview's questions aren't read aloud: this deployment keeps everything in the EU, and ${whereItRuns} isn't.`;
    }
    if (feature === "conversion") {
      return t`Grasp converts uploaded PDFs with ${whereItRuns}, using Grasp's own key. Files in sensitive collections are converted on this deployment and never sent out.`;
    }
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
    <SettingsSection
      description={t`These features always use Grasp's own provider keys, whichever providers you connect above.`}
      title={t`Grasp's own AI features`}
    >
      <SettingsBody>
        <ul className="flex flex-col gap-2">
          {uses.map((use) => (
            <li key={use.feature}>{usageLine(use)}</li>
          ))}
        </ul>
      </SettingsBody>
    </SettingsSection>
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
  return (
    <>
      <SettingsSection
        description={t`Grasp's AI calls models with your organization's own provider keys. Keys are stored sealed: nobody can read one back, only its last four characters.`}
        title={t`AI providers`}
      >
        <ErrorText>{failure}</ErrorText>
        {providers.length === 0 ? (
          <SettingsBody>
            <p className="text-muted-foreground">
              {editable ? (
                <Trans>
                  No AI provider is connected yet, so Grasp&apos;s AI features
                  can&apos;t answer. Add one below.
                </Trans>
              ) : (
                <Trans>
                  No AI provider is connected yet, so Grasp&apos;s AI features
                  can&apos;t answer.
                </Trans>
              )}
            </p>
          </SettingsBody>
        ) : (
          <ul aria-label={t`Connected providers`}>
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
          </ul>
        )}
      </SettingsSection>
      {editable && addable.length > 0 ? (
        <AddProvider
          busy={busy}
          offered={addable}
          onAdd={async (provider, key, baseUrl) =>
            await change(async (session) =>
              provider === "openai-compatible"
                ? await session.aiProviders.add({ provider, key, baseUrl })
                : await session.aiProviders.add({ provider, key })
            )
          }
        />
      ) : null}
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
        busy={busy}
        onClose={() => {
          setRemoving(null);
        }}
        onRemove={(provider) => {
          void (async () => {
            if (
              await change(async (session) => {
                await session.aiProviders.remove(provider);
              })
            ) {
              setRemoving(null);
              setTests((now) => ({ ...now, [provider]: undefined }));
            }
          })();
        }}
        provider={removing}
      />
      {platform.length === 0 ? null : <PlatformUses uses={platform} />}
    </>
  );
};
