import {
  compatibleModelNamePattern,
  featuredModels,
} from "@grasp-os/shared/ai-providers";
import type {
  AiProviderModel,
  AiProvidersListing,
  AiProviderTest,
  GraspAiListed,
  OrganizationProviderId,
} from "@grasp-os/shared/ai-providers";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import {
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useId, useState } from "react";

import { failureMessage } from "../chat/failure.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { Heading, Onward, Primary } from "./setup-parts.tsx";
import type { StepVoice } from "./setup-parts.tsx";
import type { AiReadiness } from "./setup.ts";

// The AI step of the onboarding, right after the welcome: every step after
// it has Grasp's AI read or talk on the organization's own provider key,
// so the key and the model are asked for before any of them. One provider,
// one key, one model: the admin picks them, and going on saves the key
// (core hands it to connect, which seals it), asks the model one tiny
// question, and chooses the model only once it answered. A key that
// doesn't work is removed again, says why and stays here. Fallback models and a second
// provider are for Settings › AI providers, which reads the same listing.

/** The prefix of an OpenAI-compatible endpoint's models, which the organization names. */
const compatiblePrefix = "openai-compatible/";

type Offered = AiProvidersListing["offered"][number];

/**
 * The models to choose from of `offered`: the ones most organizations
 * choose, in that order, or all of them once asked for (`all`), and where
 * the catalog has none of the featured ones.
 */
export const modelsToOffer = (
  offered: Pick<Offered, "provider" | "models">,
  all: boolean
): AiProviderModel[] => {
  const featured = featuredModels[offered.provider].flatMap((model) => {
    const found = offered.models.find((each) => each.model === model);
    return found === undefined ? [] : [found];
  });
  return all || featured.length === 0 ? offered.models : featured;
};

/** What the admin gave on the step. */
interface Given {
  provider: OrganizationProviderId;
  key: string;
  baseUrl: string;
  model: string;
}

/**
 * Saves the key, asks the model one tiny question, and chooses the model
 * once it answered: how the question went. A key whose model didn't
 * answer is removed again, so no provider stays connected that can't be
 * called, whichever provider the admin tries next.
 */
const connect = async (
  session: Session,
  { provider, key, baseUrl, model }: Given,
  onGrasp: boolean
): Promise<AiProviderTest> => {
  await (provider === "openai-compatible"
    ? session.aiProviders.add({ provider, key, baseUrl })
    : session.aiProviders.add({ provider, key }));
  const tested = await session.aiProviders.test(provider, model);
  await (tested.ok
    ? session.aiProviders.setModels({ defaultModel: model })
    : session.aiProviders.remove(provider));
  // Its own key answered: its AI runs on it from here on.
  if (tested.ok && onGrasp) {
    await session.aiProviders.setSource("own");
  }
  return tested;
};

/** Why the model didn't answer, said to the admin who just gave the key. */
const useWhy = () => {
  const { t, i18n } = useLingui();
  return (code: string, label: string): string =>
    code === "model.provider_key_failed"
      ? t`${label} refused that key. Check it in your provider's console and paste it again.`
      : failureMessage(code, i18n);
};

/** A model is ready for calls: who answers, and the way on. */
const Connected = ({
  providers,
  grasp,
  onDone,
}: {
  providers: readonly string[];
  /** Grasp's AI's model by name, where the organization's AI runs on it. */
  grasp: string | null;
  onDone: () => void;
}) => {
  const { t } = useLingui();
  const names = formatList([...providers]);
  if (grasp !== null) {
    return (
      <>
        <Onward>
          <p className="text-muted-foreground flex items-center justify-center gap-2">
            <CheckIcon
              aria-hidden="true"
              className="text-status-agreed size-4 flex-none"
            />
            <span>{t`On Grasp’s AI: ${grasp}`}</span>
          </p>
        </Onward>
        <Primary onClick={onDone}>{t`Continue`}</Primary>
      </>
    );
  }
  return (
    <>
      {providers.length === 0 ? null : (
        <Onward>
          <p className="text-muted-foreground flex items-center justify-center gap-2">
            <CheckIcon
              aria-hidden="true"
              className="text-status-agreed size-4 flex-none"
            />
            <span>{t`Connected: ${names}`}</span>
          </p>
        </Onward>
      )}
      <Primary onClick={onDone}>{t`Continue`}</Primary>
    </>
  );
};

/** The provider, its key and the model, and the way on once the model answered. */
const ConnectForm = ({
  offered,
  onGrasp,
  onDone,
  onConnected,
}: {
  offered: readonly Offered[];
  /** The organization's AI is set to Grasp's AI: a key of its own that answers sets it to its own. */
  onGrasp: boolean;
  /** The way on where there is nothing to connect. */
  onDone: () => void;
  /** The way on once the model answered. */
  onConnected: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const why = useWhy();
  const ids = useId();
  const { busy, failure, run } = useCoreAction();
  const [chosen, setChosen] = useState<OrganizationProviderId | undefined>();
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [picked, setPicked] = useState<string | undefined>();
  const [named, setNamed] = useState("");
  const [all, setAll] = useState(false);
  const [refused, setRefused] = useState<string>();
  const provider =
    offered.find((each) => each.provider === chosen) ?? offered[0];
  if (provider === undefined) {
    return <Primary onClick={onDone}>{t`Continue`}</Primary>;
  }
  const { label, whereItRuns } = provider;
  const custom = provider.provider === "openai-compatible";
  const models = modelsToOffer(provider, all);
  const listed =
    models.find((each) => each.model === picked)?.model ?? models[0]?.model;
  const model = custom ? `${compatiblePrefix}${named.trim()}` : listed;
  const ready =
    key.trim() !== "" &&
    (custom
      ? baseUrl.trim() !== "" && compatibleModelNamePattern.test(named.trim())
      : model !== undefined);
  const submit = async () => {
    if (model === undefined) {
      return;
    }
    setRefused(undefined);
    const tested = await run(
      async (session) =>
        await connect(
          session,
          {
            provider: provider.provider,
            key: key.trim(),
            baseUrl: baseUrl.trim(),
            model,
          },
          onGrasp
        )
    );
    if (tested === undefined) {
      return;
    }
    if (!tested.ok) {
      setRefused(why(tested.code, label));
      return;
    }
    // Every step reads what core now has: a model is ready for calls.
    await router.invalidate({ sync: true });
    onConnected();
  };
  return (
    <>
      <Onward>
        <div className="w-full max-w-sm text-left">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${ids}-provider`}>{t`Provider`}</FieldLabel>
              <NativeSelect
                disabled={busy}
                id={`${ids}-provider`}
                onChange={(event) => {
                  setChosen(
                    offered.find((each) => each.provider === event.target.value)
                      ?.provider
                  );
                  setPicked(undefined);
                  setAll(false);
                  setRefused(undefined);
                }}
                value={provider.provider}
              >
                {offered.map((each) => (
                  <NativeSelectOption key={each.provider} value={each.provider}>
                    {each.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>{t`Runs at: ${whereItRuns}`}</FieldDescription>
            </Field>
            {custom ? (
              <Field>
                <FieldLabel
                  htmlFor={`${ids}-base-url`}
                >{t`Base URL`}</FieldLabel>
                <Input
                  disabled={busy}
                  id={`${ids}-base-url`}
                  inputMode="url"
                  onChange={(event) => {
                    setBaseUrl(event.target.value);
                  }}
                  placeholder="https://"
                  type="url"
                  value={baseUrl}
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${ids}-key`}>{t`Key`}</FieldLabel>
              <Input
                autoComplete="off"
                disabled={busy}
                id={`${ids}-key`}
                onChange={(event) => {
                  setKey(event.target.value);
                }}
                spellCheck={false}
                type="password"
                value={key}
              />
            </Field>
            {custom ? (
              <Field>
                <FieldLabel htmlFor={`${ids}-model`}>{t`Model`}</FieldLabel>
                <Input
                  disabled={busy}
                  id={`${ids}-model`}
                  onChange={(event) => {
                    setNamed(event.target.value);
                  }}
                  value={named}
                />
                <FieldDescription>{t`As your endpoint names it, such as llama-3.3-70b.`}</FieldDescription>
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor={`${ids}-model`}>{t`Model`}</FieldLabel>
                <NativeSelect
                  disabled={busy}
                  id={`${ids}-model`}
                  onChange={(event) => {
                    setPicked(event.target.value);
                  }}
                  value={listed ?? ""}
                >
                  {models.map((each) => (
                    <NativeSelectOption key={each.model} value={each.model}>
                      {each.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                {models.length < provider.models.length ? (
                  <div>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setAll(true);
                      }}
                      size="sm"
                      variant="link"
                    >
                      {t`Use a different model`}
                    </Button>
                  </div>
                ) : null}
              </Field>
            )}
          </FieldGroup>
        </div>
        <ErrorText>{refused ?? failure}</ErrorText>
      </Onward>
      <Primary
        busy={busy}
        disabled={!ready}
        onClick={() => {
          void submit();
        }}
      >
        {t`Continue`}
      </Primary>
    </>
  );
};

/**
 * The AI step: the provider, its key and the model, until a model is
 * ready for calls; then who answers, and the way on. Where core can't say
 * (`ai` null), nothing is asked and nothing holds the admin up.
 */
/** Whose AI the organization runs on, as the step asks it. */
type Whose = "grasp" | "own";

/**
 * Grasp's AI, chosen: what it runs on and where, that it is paid by use
 * up to a month's limit, and the way on, which sets the organization's AI
 * to it.
 */
const GraspChoice = ({
  grasp,
  onConnected,
}: {
  grasp: GraspAiListed;
  onConnected: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { whereItRuns } = grasp;
  const submit = async () => {
    const set = await run(async (session) => {
      await session.aiProviders.setSource("grasp");
      return true;
    });
    if (set === true) {
      await router.invalidate({ sync: true });
      onConnected();
    }
  };
  return (
    <>
      <Onward>
        <p className="text-muted-foreground">{t`Runs at: ${whereItRuns}. A monthly limit applies: once it is reached, AI stops until the next month.`}</p>
        <ErrorText>{failure}</ErrorText>
      </Onward>
      <Primary
        busy={busy}
        onClick={() => {
          void submit();
        }}
      >
        {t`Continue`}
      </Primary>
    </>
  );
};

/**
 * No model is ready: Grasp's AI or a key of the organization's own, where
 * this deployment offers Grasp's AI; else its own key alone.
 */
const Asking = ({
  listing,
  onDone,
  onConnected,
}: {
  listing: AiProvidersListing;
  onDone: () => void;
  onConnected: () => void;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const [whose, setWhose] = useState<Whose>("grasp");
  const { grasp } = listing;
  const model = grasp.model.name;
  const own = (
    <ConnectForm
      offered={listing.offered}
      onConnected={onConnected}
      onDone={onDone}
      onGrasp={listing.source === "grasp"}
    />
  );
  if (!grasp.available) {
    return own;
  }
  return (
    <>
      <Onward>
        <RadioGroup
          aria-label={t`Which AI`}
          className="w-full max-w-sm text-left"
          onValueChange={(value: unknown) => {
            if (value === "grasp" || value === "own") {
              setWhose(value);
            }
          }}
          value={whose}
        >
          <Field orientation="horizontal">
            <RadioGroupItem id={`${ids}-grasp`} value="grasp" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel
                htmlFor={`${ids}-grasp`}
              >{t`Use Grasp’s AI`}</FieldLabel>
              <FieldDescription>{t`Nothing to set up. It runs on ${model}, and you pay for what your company uses.`}</FieldDescription>
            </div>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem id={`${ids}-own`} value="own" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel
                htmlFor={`${ids}-own`}
              >{t`Use your own key`}</FieldLabel>
              <FieldDescription>{t`Your own contract with Anthropic, OpenAI, Mistral or another provider. You pay them directly.`}</FieldDescription>
            </div>
          </Field>
        </RadioGroup>
      </Onward>
      {whose === "grasp" ? (
        <GraspChoice grasp={grasp} onConnected={onConnected} />
      ) : (
        own
      )}
    </>
  );
};

export const AiStep = ({
  ai,
  lines,
  onDone,
  onConnected,
}: {
  ai: AiReadiness | null;
  lines: { title: string; sentence: string; voice?: StepVoice };
  /** The way on for an admin who had a model already. */
  onDone: () => void;
  /** The way on for an admin whose model just answered: they may have been sent back here. */
  onConnected: () => void;
}) => (
  <>
    <Heading
      sentence={lines.sentence}
      title={lines.title}
      voice={lines.voice}
    />
    {ai === null || ai.ready ? (
      <Connected
        grasp={
          ai?.listing.source === "grasp" ? ai.listing.grasp.model.name : null
        }
        onDone={onDone}
        providers={ai?.listing.providers.map(({ label }) => label) ?? []}
      />
    ) : (
      <Asking listing={ai.listing} onConnected={onConnected} onDone={onDone} />
    )}
  </>
);
