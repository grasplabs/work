import type { ModelEffort } from "@grasp-os/shared/models";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { ComposerModel, ComposerReasoning } from "../grasp/composer/index.ts";
import type {
  ComposerModelMaker,
  ComposerModelOption,
} from "../grasp/composer/index.ts";
import {
  BrandChatGpt,
  BrandClaude,
  BrandGemini,
} from "../grasp/icons/index.ts";
import { isEffort } from "./model-choice.ts";
import { modelName } from "./model-names.tsx";

// Which model answers and how hard it thinks, as Grasp UI's Composer
// picks them (ComposerModel, ComposerReasoning): in Chat start's box and
// the running chat's alike.

/** How each effort is called, least first (as the old box calls them). */
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

/** The model a question names and how hard it thinks, where there are models to pick from. */
export const ModelControls = ({
  models: offered,
  model,
  onModel,
  efforts,
  effort,
  onEffort,
}: {
  models: readonly string[] | undefined;
  model: string;
  onModel: (model: string) => void;
  efforts: readonly ModelEffort[];
  effort: ModelEffort | undefined;
  onEffort: (effort: ModelEffort) => void;
}) => {
  const { t, i18n } = useLingui();
  const models = offered ?? [];
  const makers = [...new Set(models.map(makerOf))].map((value) => ({
    value,
    ...(knownMakers[value] ?? { label: value === "" ? t`Models` : value }),
  }));
  const options: ComposerModelOption[] = models.map((each) => ({
    value: each,
    label: modelName(each),
    maker: makerOf(each),
  }));
  return (
    <>
      {options.length === 0 ? null : (
        <ComposerModel
          label={t`Model`}
          makers={makers}
          models={options}
          onValueChange={(chosen) => {
            onModel(chosen);
          }}
          value={model}
        />
      )}
      {effort === undefined || efforts.length === 0 ? null : (
        <ComposerReasoning
          label={t`How hard it thinks`}
          levels={efforts.map((each) => ({
            value: each,
            label: i18n._(effortNames[each]),
          }))}
          onValueChange={(value) => {
            if (isEffort(value)) {
              onEffort(value);
            }
          }}
          value={effort}
        />
      )}
    </>
  );
};
