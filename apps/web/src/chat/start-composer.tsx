import type { ModelEffort } from "@grasp-os/shared/models";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import {
  Composer,
  ComposerModel,
  ComposerReasoning,
} from "../grasp/composer/index.ts";
import type {
  ComposerModelMaker,
  ComposerModelOption,
} from "../grasp/composer/index.ts";
import {
  BrandChatGpt,
  BrandClaude,
  BrandGemini,
} from "../grasp/icons/index.ts";
import { modelName } from "./composer.tsx";
import { isEffort } from "./model-choice.ts";

// Chat start's box to ask in, from Grasp UI (grasp/composer): the
// library's Composer, fed by the same ask as the old box (use-ask.ts).
// For now it asks with text alone: the library's Composer has no
// @-mentions or attachments yet. When its new version lands, this is
// where it is taken in.

const styles = stylex.create({
  // As wide as the column it stands in: Chat start's question over it.
  fill: {
    maxWidth: "100%",
  },
});

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

/** The ask's box, as use-ask.ts gives it: what this composer needs of it. */
export interface StartAsk {
  text: string;
  onText: (text: string) => void;
  models: readonly string[] | undefined;
  model: string;
  onModel: (model: string) => void;
  efforts: readonly ModelEffort[];
  effort: ModelEffort | undefined;
  onEffort: (effort: ModelEffort) => void;
  busy: boolean;
  failure: string | undefined;
  onSend: () => void;
  onStop: () => void;
}

/** The library's Composer, asking as Chat start asks. */
export const StartComposer = ({
  ask,
  start,
  end,
}: {
  ask: StartAsk;
  /** At the footer's start: the agent to ask. */
  start?: ReactNode;
  /** At the footer's end, before send: Recents. */
  end?: ReactNode;
}) => {
  const { t, i18n } = useLingui();
  const models = ask.models ?? [];
  const makers = [...new Set(models.map(makerOf))].map((value) => ({
    value,
    ...(knownMakers[value] ?? { label: value === "" ? t`Models` : value }),
  }));
  const options: ComposerModelOption[] = models.map((model) => ({
    value: model,
    label: modelName(model),
    maker: makerOf(model),
  }));
  const controls = (
    <>
      {options.length === 0 ? null : (
        <ComposerModel
          label={t`Model`}
          makers={makers}
          models={options}
          onValueChange={(model) => {
            ask.onModel(model);
          }}
          value={ask.model}
        />
      )}
      {ask.effort === undefined || ask.efforts.length === 0 ? null : (
        <ComposerReasoning
          label={t`How hard it thinks`}
          levels={ask.efforts.map((effort) => ({
            value: effort,
            label: i18n._(effortNames[effort]),
          }))}
          onValueChange={(value) => {
            if (isEffort(value)) {
              ask.onEffort(value);
            }
          }}
          value={ask.effort}
        />
      )}
    </>
  );
  return (
    <Composer
      activity={ask.busy ? "working" : "idle"}
      controls={controls}
      end={end}
      failedLabel={t`Could not send`}
      label={t`Message`}
      onSend={() => {
        ask.onSend();
      }}
      onStop={() => {
        ask.onStop();
      }}
      onValueChange={(value) => {
        ask.onText(value);
      }}
      placeholder={t`Ask anything, or describe a process`}
      start={start}
      layout={styles.fill}
      validation={ask.failure}
      value={ask.text}
    />
  );
};
