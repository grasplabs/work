import type { ModelEffort } from "@grasp-os/shared/models";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { PromptInputButton } from "@grasp-os/ui/components/prompt-input";
import { Slider } from "@grasp-os/ui/components/slider";
import { cn } from "@grasp-os/ui/lib/utils";
import { msg, select } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { useId } from "react";

import { ProviderMark } from "./provider-mark.tsx";

// The chat box's one control for who answers and how hard it thinks
// first, as the prototype has it (grasplabs/prototype
// `components/chat/model-picker.tsx`, `thinking-bar.tsx`): it reads
// "glm-5.3-flash · ●●○ High", and opens on the models core offers, one
// line each with its provider's mark, and under them, for a model that
// thinks, a bar from its least effort to its most. Picking a model leaves
// it open, so the thinking can be set in the same go. For an admin, one
// last line adds another provider, in the models' settings. What the
// person picks is kept as before (model-choice.ts).

/** How a model is named in the box: the last part of its ID. */
export const modelName = (model: string): string =>
  model.split("/").at(-1) ?? model;

/** How each effort is called, least first. */
const effortNames = {
  low: msg({ message: "Low", context: "thinking effort" }),
  medium: msg({ message: "Medium", context: "thinking effort" }),
  high: msg({ message: "High", context: "thinking effort" }),
  xhigh: msg({ message: "Extra high", context: "thinking effort" }),
  max: msg({ message: "Max", context: "thinking effort" }),
} as const;

/** The two highest efforts look like more than the rest: warm. */
const isSpecial = (effort: ModelEffort): boolean =>
  effort === "xhigh" || effort === "max";

/**
 * The level at a glance, in the size of an icon: a dot for each effort the
 * model takes, each larger than the last, inked as far as `effort` goes.
 */
const LevelDots = ({
  levels,
  effort,
}: {
  levels: readonly ModelEffort[];
  effort: ModelEffort;
}) => {
  const at = levels.indexOf(effort);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex flex-none items-center gap-0.5",
        isSpecial(effort) && "text-brain-heat"
      )}
    >
      {levels.map((each, index) => (
        <span
          className={cn(
            "rounded-full bg-current",
            index === 0 && "size-1",
            index === 1 && "size-1.5",
            index >= 2 && "size-2",
            index > at && "opacity-25"
          )}
          key={each}
        />
      ))}
    </span>
  );
};

/** The dots under the thinking bar's handle, inked as far as it is. */
const ThinkingField = ({ count, at }: { count: number; at: number }) => (
  <span
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 flex items-center justify-between px-4"
  >
    {Array.from({ length: count }, (_, index) => (
      <span
        className={cn(
          "bg-foreground size-1.5 rounded-full",
          index > at && "opacity-25"
        )}
        // The dots stand for the levels, which never reorder.
        key={index}
      />
    ))}
  </span>
);

/** How hard the model thinks before it answers: one bar, least to most. */
const ThinkingBar = ({
  levels,
  effort,
  onEffort,
}: {
  levels: readonly ModelEffort[];
  effort: ModelEffort;
  onEffort: (effort: ModelEffort) => void;
}) => {
  const { t } = useLingui();
  const label = useId();
  const at = levels.indexOf(effort);
  const [least] = levels;
  const most = levels.at(-1);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 pl-1">
        <span className="text-muted-foreground" id={label}>
          <Trans>Thinking</Trans>
        </span>
        <span>{t(effortNames[effort])}</span>
      </div>
      <Slider
        aria-labelledby={label}
        className="my-1"
        field={<ThinkingField at={at} count={levels.length} />}
        getAriaValueText={(_formatted: string, value: number) => {
          const level = levels[value];
          return level === undefined ? "" : t(effortNames[level]);
        }}
        max={levels.length - 1}
        min={0}
        onValueChange={(value) => {
          const index = typeof value === "number" ? value : value[0];
          const next = index === undefined ? undefined : levels[index];
          if (next !== undefined) {
            onEffort(next);
          }
        }}
        step={1}
        value={at}
        variant="pill"
      />
      {least === undefined || most === undefined ? null : (
        <div className="text-muted-foreground flex justify-between px-1 text-xs">
          <span>{t(effortNames[least])}</span>
          <span>{t(effortNames[most])}</span>
        </div>
      )}
    </div>
  );
};

/** Which model answers the next question, and how hard it thinks first. */
export const ModelPicker = ({
  models,
  model,
  onModel,
  efforts,
  effort,
  onEffort,
  addProvider,
}: {
  models: readonly string[];
  model: string;
  onModel: (model: string) => void;
  /** The efforts `model` takes, least first; none for one that doesn't think. */
  efforts: readonly ModelEffort[];
  effort: ModelEffort | undefined;
  onEffort: ((effort: ModelEffort) => void) | undefined;
  /** Whether the person may add a provider: only an admin opens the models' settings. */
  addProvider: boolean;
}) => {
  const { t } = useLingui();
  const name = modelName(model);
  const thinking =
    efforts.length > 0 && onEffort !== undefined && effort !== undefined
      ? { effort, onEffort }
      : undefined;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={
          thinking === undefined || effort === undefined
            ? t`Model: ${name}. Change model`
            : t`Model: ${name}, thinking ${select(effort, {
                low: "low",
                medium: "medium",
                high: "high",
                xhigh: "extra high",
                other: "max",
              })}. Change model or thinking`
        }
        render={<PromptInputButton size="sm" />}
      >
        <ProviderMark model={model} />
        {/* As the text in the box is written: not heavier, not larger. */}
        <span className="text-foreground max-w-48 truncate font-normal">
          {name}
        </span>
        {thinking === undefined ? null : (
          <>
            <LevelDots effort={thinking.effort} levels={efforts} />
            <span className="font-normal">
              {t(effortNames[thinking.effort])}
            </span>
          </>
        )}
        <ChevronDownIcon className="text-muted-foreground size-3.5" />
      </PopoverTrigger>
      {/* Opened by a press, nothing in it is marked as focused: the first Tab goes to the first model. */}
      <PopoverContent
        align="start"
        className="w-80"
        initialFocus={false}
        variant="flush"
      >
        <fieldset aria-label={t`Model`} className="flex min-w-0 flex-col p-1.5">
          {models.map((each, index) => (
            <button
              aria-pressed={each === model}
              className="hover:bg-accent focus-visible:ring-ring/50 flex h-9 items-center gap-2.5 rounded-md px-2.5 text-left outline-none focus-visible:ring-3"
              key={each}
              onClick={() => {
                onModel(each);
              }}
              title={each}
              type="button"
            >
              <ProviderMark model={each} />
              <span className="min-w-0 flex-1 truncate">{modelName(each)}</span>
              {index === 0 ? (
                <span className="text-muted-foreground text-xs">
                  <Trans context="the default model">Default</Trans>
                </span>
              ) : null}
              {each === model ? (
                <CheckIcon aria-hidden="true" className="size-4" />
              ) : null}
            </button>
          ))}
        </fieldset>
        {thinking === undefined ? null : (
          <div className="border-t p-3">
            <ThinkingBar
              effort={thinking.effort}
              levels={efforts}
              onEffort={(chosen) => {
                thinking.onEffort(chosen);
              }}
            />
          </div>
        )}
        {addProvider ? (
          <div className="flex flex-col border-t p-1.5">
            <Link
              className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 flex h-9 items-center gap-2.5 rounded-md px-2.5 outline-none focus-visible:ring-3"
              to="/settings/models"
            >
              <PlusIcon aria-hidden="true" className="size-4" />
              <Trans>Add another provider</Trans>
            </Link>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
};
