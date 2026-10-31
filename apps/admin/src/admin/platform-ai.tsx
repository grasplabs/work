/**
 * Platform → AI: which provider and model each of Grasp's own AI features
 * uses (src/platform-ai.ts), chosen by staff, audited, and given to every
 * client's core with its next deploy. Only a provider Grasp has its own
 * key for is offered; the keys themselves live in Secrets Store and are
 * never shown.
 */
import {
  aiProviderIdSchema,
  aiProviders,
  platformRegions,
  platformRouteOf,
} from "@grasp-os/shared/ai-providers";
import type {
  AiProviderId,
  PlatformRegion,
} from "@grasp-os/shared/ai-providers";
import {
  conversionProviders,
  speechModels,
  speechProviders,
  speechVoicesOf,
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
import { Section } from "./section.tsx";

/** What a refusal says. */
const refusals: Readonly<Record<PlatformAiRefusal, string>> = {
  invalid:
    "Those aren't settings core takes: a model or voice name has a character it doesn't, or a speaker has a voice the speech model doesn't have.",
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
      quickModel: text(form, "speech-quick-model"),
      voices,
    },
    region: text(form, "region"),
  };
};

/** Where Grasp's OpenAI project and ElevenLabs account keep their data, as the region's choice says it. */
const regionWords: Readonly<Record<PlatformRegion, string>> = {
  eu: "European Union: eu.api.openai.com and api.eu.residency.elevenlabs.io",
  us: "United States: api.openai.com and api.elevenlabs.io",
};

/** Where `provider` runs a feature on Grasp's key, in `region` (`platformRouteOf`). */
const whereItRunsOf = (provider: string, region: PlatformRegion): string => {
  const id = aiProviderIdSchema.safeParse(provider).data;
  const known = id === undefined ? undefined : platformRouteOf(id, region);
  return known === undefined ? "" : `Runs at ${known.whereItRuns}. `;
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
  whereItRuns,
  models,
}: {
  feature: string;
  label: string;
  description: string;
  providers: readonly AiProviderId[];
  keyed: readonly AiProviderId[];
  provider: string;
  model: string;
  withLocal?: boolean;
  /** Where the chosen provider runs it, by the region; empty for local. */
  whereItRuns: string;
  /** The models it may be, to choose from; any model by name when none. */
  models?: readonly string[];
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
          <FieldDescription>{`${whereItRuns}${description}`}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${feature}-model`}>Model</FieldLabel>
          {models === undefined ? (
            <Input
              className="max-w-80"
              defaultValue={model}
              id={`${feature}-model`}
              name={`${feature}-model`}
            />
          ) : (
            <NativeSelect
              className="max-w-80"
              defaultValue={model}
              id={`${feature}-model`}
              name={`${feature}-model`}
            >
              {models.map((each) => (
                <NativeSelectOption key={each} value={each}>
                  {each}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Field>
      </FieldGroup>
    </div>
  );
};

/** What the page says of the providers Grasp has a key for. */
const keyedWords = (keyed: readonly AiProviderId[]): string =>
  keyed.length === 0
    ? "Grasp has no AI provider key in Secrets Store yet, so its AI features aren't configured yet in any organization and no provider can be chosen: add OPENAI_API_KEY (or another provider's) to the stage’s 1Password Environment, then run Deploy platform."
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
    <Section
      description={
        updated === null
          ? `The defaults stand, OpenAI's and ElevenLabs's: nobody chose yet. ${keyedWords(keyed)}`
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
        <div className="border-t px-5 py-4">
          <Field>
            <FieldLabel htmlFor="region">
              Where Grasp&apos;s OpenAI project and ElevenLabs account keep
              their data
            </FieldLabel>
            <NativeSelect
              className="max-w-80"
              defaultValue={settings.region}
              id="region"
              name="region"
            >
              {platformRegions.map((each) => (
                <NativeSelectOption key={each} value={each}>
                  {regionWords[each]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>
              Each key must be that project&apos;s or account&apos;s. A company
              that keeps everything in the EU uses Grasp&apos;s OpenAI and
              ElevenLabs features only while this is the European Union;
              otherwise its PDFs are read locally and its interviews go without
              speech and live transcription.
            </FieldDescription>
          </Field>
        </div>
        <FeatureFields
          description="A PDF dropped into a company's Brain, read into text by a model that takes the file itself. Word and Excel files and sensitive collections are always read locally."
          feature="conversion"
          keyed={keyed}
          label="Document conversion"
          model={conversionModel(settings)}
          provider={settings.conversion.provider}
          providers={conversionProviders}
          whereItRuns={whereItRunsOf(
            settings.conversion.provider,
            settings.region
          )}
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
          whereItRuns={whereItRunsOf(
            settings.transcription.provider,
            settings.region
          )}
        />
        <FeatureFields
          description="The onboarding's lines said out loud, each with when its words are said."
          feature="speech"
          keyed={keyed}
          label="Speech"
          model={settings.speech.model}
          models={speechModels}
          provider={settings.speech.provider}
          providers={speechProviders}
          whereItRuns={whereItRunsOf(settings.speech.provider, settings.region)}
        />
        <div className="border-t px-5 py-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="speech-quick-model">Quick model</FieldLabel>
              <NativeSelect
                className="max-w-80"
                defaultValue={settings.speech.quickModel}
                id="speech-quick-model"
                name="speech-quick-model"
              >
                {speechModels.map((each) => (
                  <NativeSelectOption key={each} value={each}>
                    {each}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>
                For a line only known as it is said, such as one with a name.
              </FieldDescription>
            </Field>
            <FieldDescription>
              {`Each speaker's voice, by its ElevenLabs ID, one Grasp chose: ${speechVoicesOf[settings.speech.model].join(", ")}. Left empty, the default voice.`}
            </FieldDescription>
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
    </Section>
  );
};
