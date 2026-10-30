/**
 * Platform → AI: which provider and model each of Grasp's own AI features
 * uses (src/platform-ai.ts), chosen by staff, audited, and given to every
 * client's core with its next deploy. Only a provider Grasp has its own
 * key for is offered; the keys themselves live in Secrets Store and are
 * never shown.
 */
import { aiProviders } from "@grasp-os/shared/ai-providers";
import type { AiProviderId } from "@grasp-os/shared/ai-providers";
import {
  conversionProviders,
  speechProviders,
  transcriptionProviders,
} from "@grasp-os/shared/platform-ai";
import { speakers } from "@grasp-os/shared/voice";
import type { Speaker } from "@grasp-os/shared/voice";
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
import { useRouter } from "@tanstack/react-router";

import { setPlatformAiFn } from "../platform-ai-functions.ts";
import type {
  PlatformAiRefusal,
  PlatformAiSettings,
  PlatformAiView,
} from "../platform-ai.ts";
import { formatTime } from "../releases/format.ts";
import { thenRefresh, useAction } from "../use-action.ts";
import { Panel } from "./panel.tsx";

/** What a refusal says. */
const refusals: Readonly<Record<PlatformAiRefusal, string>> = {
  invalid:
    "Those aren't settings core takes: a model or voice name has a character it doesn't.",
  key_missing:
    "Grasp has no key for a provider chosen: add its key to the stage’s 1Password Environment and run Deploy platform, or choose another.",
};

/** The value a conversion's select gives for reading every file locally. */
const local = "local";

const speakerNames: Record<Speaker, string> = {
  stephen: "Stephen",
  claire: "Claire",
  mark: "Mark",
  lisa: "Lisa",
  tim: "Tim",
};

/** `providers` that may be chosen: those with Grasp's key, and the one chosen now. */
const offered = (
  providers: readonly AiProviderId[],
  keyed: readonly AiProviderId[],
  chosen: string
): AiProviderId[] =>
  providers.filter((each) => keyed.includes(each) || each === chosen);

/** A provider as an option says it: its name, and when Grasp has no key for it. */
const providerWords = (
  provider: AiProviderId,
  keyed: readonly AiProviderId[]
): string =>
  keyed.includes(provider)
    ? aiProviders[provider].label
    : `${aiProviders[provider].label} (no Grasp key)`;

/** A form field's text, trimmed; empty when it isn't there. */
const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** The settings the form holds, as words: the server checks them (`platformAiSchema`). */
const settingsOf = (form: FormData): Record<string, unknown> => {
  const conversion = text(form, "conversion-provider");
  const voices = Object.fromEntries(
    speakers.flatMap((speaker) => {
      const voice = text(form, `voice-${speaker}`);
      return voice === "" ? [] : [[speaker, voice]];
    })
  );
  return {
    conversion:
      conversion === local
        ? { provider: local }
        : { provider: conversion, model: text(form, "conversion-model") },
    transcription: {
      provider: text(form, "transcription-provider"),
      model: text(form, "transcription-model"),
    },
    speech: {
      provider: text(form, "speech-provider"),
      model: text(form, "speech-model"),
      voices,
    },
  };
};

/** One feature's provider and model fields. */
const FeatureFields = ({
  feature,
  label,
  description,
  providers,
  keyed,
  provider,
  model,
  withLocal = false,
}: {
  feature: string;
  label: string;
  description: string;
  providers: readonly AiProviderId[];
  keyed: readonly AiProviderId[];
  provider: string;
  model: string;
  withLocal?: boolean;
}) => {
  const choices = offered(providers, keyed, provider);
  return (
    <div className="border-t px-5 py-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${feature}-provider`}>{label}</FieldLabel>
          <NativeSelect
            className="max-w-80"
            defaultValue={provider}
            id={`${feature}-provider`}
            name={`${feature}-provider`}
          >
            {choices.map((each) => (
              <NativeSelectOption key={each} value={each}>
                {providerWords(each, keyed)}
              </NativeSelectOption>
            ))}
            {withLocal ? (
              <NativeSelectOption value={local}>
                Read locally: nothing sent out
              </NativeSelectOption>
            ) : null}
          </NativeSelect>
          <FieldDescription>{description}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${feature}-model`}>Model</FieldLabel>
          <Input
            className="max-w-80"
            defaultValue={model}
            id={`${feature}-model`}
            name={`${feature}-model`}
          />
        </Field>
      </FieldGroup>
    </div>
  );
};

/** What the page says of the providers Grasp has a key for. */
const keyedWords = (keyed: readonly AiProviderId[]): string =>
  keyed.length === 0
    ? "Grasp has no AI provider key in Secrets Store yet, so no provider can be chosen: add OPENAI_API_KEY (or another provider's) to the stage’s 1Password Environment, then run Deploy platform."
    : `Grasp has its own key for ${keyed.map((each) => aiProviders[each].label).join(", ")}. Another provider is offered once its key is in the stage’s 1Password Environment and Deploy platform ran.`;

/** The model a conversion setting names; none for reading locally. */
const conversionModel = (settings: PlatformAiSettings): string =>
  settings.conversion.provider === local ? "" : settings.conversion.model;

/** Each of Grasp's own AI features' provider and model, and choosing them. */
export const PlatformAi = ({ view }: { view: PlatformAiView }) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(refusals);
  const { settings, keyed, updated } = view;
  // Keyed by what was read: the form starts again from it after each save.
  const shown = JSON.stringify(settings);
  return (
    <Panel
      description={
        updated === null
          ? `OpenAI's defaults stand: nobody chose yet. ${keyedWords(keyed)}`
          : `${updated.by} chose these on ${formatTime(updated.at)} UTC. ${keyedWords(keyed)}`
      }
      title="Grasp's own AI features"
    >
      <form
        key={shown}
        onSubmit={(event) => {
          event.preventDefault();
          const chosen = settingsOf(new FormData(event.currentTarget));
          void run(
            async () =>
              await thenRefresh(
                async () =>
                  await setPlatformAiFn({ data: { settings: chosen } }),
                async () => {
                  await router.invalidate({ sync: true });
                }
              )
          );
        }}
      >
        <FeatureFields
          description="A PDF dropped into a company's Brain, read into text by a model that takes the file itself. Word and Excel files, sensitive collections and EU-only companies are always read locally."
          feature="conversion"
          keyed={keyed}
          label="Document conversion"
          model={conversionModel(settings)}
          provider={settings.conversion.provider}
          providers={conversionProviders}
          withLocal
        />
        <FeatureFields
          description="What people say on the onboarding's pages, written down live and from recordings."
          feature="transcription"
          keyed={keyed}
          label="Transcription"
          model={settings.transcription.model}
          provider={settings.transcription.provider}
          providers={transcriptionProviders}
        />
        <FeatureFields
          description="The onboarding's lines said out loud."
          feature="speech"
          keyed={keyed}
          label="Speech"
          model={settings.speech.model}
          provider={settings.speech.provider}
          providers={speechProviders}
        />
        <div className="border-t px-5 py-4">
          <FieldGroup>
            {speakers.map((speaker) => (
              <Field key={speaker}>
                <FieldLabel htmlFor={`voice-${speaker}`}>
                  {`${speakerNames[speaker]}'s voice`}
                </FieldLabel>
                <Input
                  className="max-w-80"
                  defaultValue={settings.speech.voices[speaker] ?? ""}
                  id={`voice-${speaker}`}
                  name={`voice-${speaker}`}
                />
              </Field>
            ))}
          </FieldGroup>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t px-5 py-4">
          <Button disabled={busy} size="sm" type="submit">
            Save
          </Button>
          <p className="text-muted-foreground text-sm">
            Each company gets it with its next deploy: a rollout, or Apply
            settings on its Setup.
          </p>
          {failure === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {failure}
            </p>
          )}
        </div>
      </form>
    </Panel>
  );
};
