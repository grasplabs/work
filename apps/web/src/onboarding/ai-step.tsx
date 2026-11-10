import {
  compatibleModelNamePattern,
  featuredModels,
} from "@grasp-os/shared/ai-providers";
import type {
  AiProviderModel,
  AiProvidersListing,
  AiProviderTest,
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
  { provider, key, baseUrl, model }: Given
): Promise<AiProviderTest> => {
  await (provider === "openai-compatible"
    ? session.aiProviders.add({ provider, key, baseUrl })
    : session.aiProviders.add({ provider, key }));
  const tested = await session.aiProviders.test(provider, model);
  await (tested.ok
    ? session.aiProviders.setModels({ defaultModel: model })
    : session.aiProviders.remove(provider));
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
  onDone,
}: {
  providers: readonly string[];
  onDone: () => void;
}) => {
  const { t } = useLingui();
  const names = formatList([...providers]);
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
  onDone,
  onConnected,
}: {
  offered: readonly Offered[];
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
        await connect(session, {
          provider: provider.provider,
          key: key.trim(),
          baseUrl: baseUrl.trim(),
          model,
        })
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
        onDone={onDone}
        providers={ai?.listing.providers.map(({ label }) => label) ?? []}
      />
    ) : (
      <ConnectForm
        offered={ai.listing.offered}
        onConnected={onConnected}
        onDone={onDone}
      />
    )}
  </>
);
