import type { ModelEffort } from "@grasp-os/shared/models";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { ComposerModelEffort } from "../grasp/composer/index.ts";
import type {
  ComposerModelEffortOption,
  ComposerModelMaker,
} from "../grasp/composer/index.ts";
import {
  BrandChatGpt,
  BrandClaude,
  BrandGemini,
} from "../grasp/icons/index.ts";
import { isEffort } from "./model-choice.ts";
import { modelName } from "./model-names.tsx";

// Which model answers and how hard it thinks, as one control in the
// Composer's `controls` (Grasp UI's ComposerModelEffort): in Chat start's
// box and the running chat's alike, for everyone.

/** How each effort is called, least first. */
const effortNames = {
  low: msg({ message: "Low", context: "thinking effort" }),
  medium: msg({ message: "Medium", context: "thinking effort" }),
  high: msg({ message: "High", context: "thinking effort" }),
  xhigh: msg({ message: "Extra high", context: "thinking effort" }),
  max: msg({ message: "Max", context: "thinking effort" }),
} as const;

/** The makers Grasp knows a mark for, by the first part of a model's ID. */
const knownMakers: Record<string, Omit<ComposerModelMaker, "value">> = {
  openai: { label: "OpenAI", icon: BrandChatGpt },
  anthropic: { label: "Anthropic", icon: BrandClaude },
  google: { label: "Google", icon: BrandGemini },
};

/** Who makes `model`: the first part of its ID, or none for an ID with one part. */
const makerOf = (model: string): string =>
  model.includes("/") ? (model.split("/")[0] ?? "") : "";

/**
 * The model a question names and how hard it thinks, where there are
 * models to pick from. Core offers one set of efforts for every model, so
 * each model gets them all.
 */
export const ModelControls = ({
  agentModel,
  models: offered,
  model: picked,
  onModel,
  efforts,
  effort,
  onEffort,
}: {
  /** The model the chat's agent answers with, where an admin gave it one: the only one offered. */
  agentModel: string | undefined;
  /** Undefined while core hasn't said which. */
  models: readonly string[] | undefined;
  model: string | undefined;
  onModel: ((model: string) => void) | undefined;
  efforts: readonly ModelEffort[];
  effort: ModelEffort | undefined;
  onEffort: ((effort: ModelEffort) => void) | undefined;
}) => {
  const { t, i18n } = useLingui();
  const models = agentModel === undefined ? (offered ?? []) : [agentModel];
  const model = agentModel ?? picked ?? "";
  if (models.length === 0) {
    return null;
  }
  const makers = [...new Set(models.map(makerOf))].map((value) => ({
    value,
    ...(knownMakers[value] ?? { label: value === "" ? t`Models` : value }),
  }));
  const levels =
    effort === undefined
      ? []
      : efforts.map((each) => ({
          value: each,
          label: i18n._(effortNames[each]),
        }));
  const options: ComposerModelEffortOption[] = models.map((each) => ({
    value: each,
    label: modelName(each),
    maker: makerOf(each),
    levels,
  }));
  return (
    <ComposerModelEffort
      effort={effort ?? ""}
      effortLabel={t`How hard it thinks`}
      label={t`Model and effort`}
      makers={makers}
      model={model}
      modelLabel={t`Model`}
      models={options}
      noEffortLabel={t`This model has one level of effort.`}
      onEffortChange={(value) => {
        if (isEffort(value)) {
          onEffort?.(value);
        }
      }}
      onModelChange={(chosen) => {
        onModel?.(chosen);
      }}
    />
  );
};
