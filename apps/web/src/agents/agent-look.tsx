import type { Agent } from "@grasp-os/shared/agents";
import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { AgentFigure } from "./figure/agent-figure.tsx";
import type { FigureShape as AgentFigureShape } from "./figure/body.ts";
import { faceOf, lookOf } from "./figure/look.ts";
import { agentFigurePalettes } from "./figure/palettes.ts";
import type { AgentFigureLook, AgentFigurePalette } from "./figure/palettes.ts";
import { SectionCard } from "./section-card.tsx";
import { SettingRow } from "./setting-row.tsx";

// An agent's look on its page (Ruben, 21 November: "adjust your agent
// figure and color"): the figure as it looks now, large, beside its shape
// and its colours, each chosen by name, so the figure shows what is chosen. The look
// is kept in the agent's `face` (figure/look.ts). Never on the company's
// first agent, whose look is fixed.

/** The shapes offered: the library's lit bodies a person can tell apart. */
export const offeredShapes = [
  "orb",
  "trio",
  "pair",
  "swarm",
  "prism",
  "crystal",
  "planet",
] as const satisfies readonly AgentFigureShape[];

const styles = stylex.create({
  control: { width: "12rem", maxWidth: "100%" },
});

/** The Look card: the agent's shape and colours, each picked to change it. */
export const AgentLook = ({
  agent,
  can,
  pick,
}: {
  agent: Agent;
  /** Whether it may be changed now. */
  can: boolean;
  /** Takes the face picked, for the Edit dialog to save with the rest. */
  pick: (face: string) => void;
}) => {
  const { t } = useLingui();
  const look = lookOf(agent);
  const shapeNames: Record<(typeof offeredShapes)[number], string> = {
    orb: t`Orb`,
    trio: t`Three circling`,
    pair: t`Pair in orbit`,
    swarm: t`Swarm`,
    prism: t`Triangle`,
    crystal: t`Crystal`,
    planet: t`Planet`,
  };
  const paletteNames: Record<AgentFigurePalette, string> = {
    evergreen: t`Evergreen`,
    meadow: t`Meadow`,
    ember: t`Ember`,
    amber: t`Amber`,
    ocean: t`Ocean`,
    moon: t`Moon`,
  };
  // The shapes offered, and the agent's own where it has another.
  const shapes: readonly AgentFigureShape[] = offeredShapes.some(
    (shape) => shape === look.shape
  )
    ? offeredShapes
    : [look.shape, ...offeredShapes];
  const shapeNameOf = (shape: AgentFigureShape): string => {
    const offered = offeredShapes.find((each) => each === shape);
    return offered === undefined
      ? `${shape.charAt(0).toUpperCase()}${shape.slice(1)}`
      : shapeNames[offered];
  };
  const choose = (next: AgentFigureLook): void => {
    pick(faceOf(next));
  };
  return (
    <SectionCard
      // The agent as it looks now, beside the card's name: it changes as
      // a shape or colours are chosen.
      aside={<AgentFigure look={look} size="sm" />}
      flush
      title={t`Look`}
    >
      <FieldGroup>
        <SettingRow label={t`Shape`}>
          {(field) => (
            <Select
              disabled={!can}
              items={shapes.map((shape) => ({
                value: shape,
                label: shapeNameOf(shape),
              }))}
              onValueChange={(value) => {
                const shape = shapes.find((each) => each === value);
                if (shape !== undefined) {
                  choose({ ...look, shape });
                }
              }}
              value={look.shape}
            >
              <SelectTrigger {...field} style={styles.control} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent />
            </Select>
          )}
        </SettingRow>
        <SettingRow label={t`Colours`}>
          {(field) => (
            <Select
              disabled={!can}
              items={agentFigurePalettes.map((palette) => ({
                value: palette,
                label: paletteNames[palette],
              }))}
              onValueChange={(value) => {
                const palette = agentFigurePalettes.find(
                  (each) => each === value
                );
                if (palette !== undefined) {
                  choose({ ...look, palette });
                }
              }}
              value={look.palette}
            >
              <SelectTrigger {...field} style={styles.control} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent />
            </Select>
          )}
        </SettingRow>
      </FieldGroup>
    </SectionCard>
  );
};
