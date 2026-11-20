import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { AgentTemplate } from "./agent-templates.ts";

// The harness every agent's instructions are written in (Ruben, 19 Nov
// 2026: "really descriptive, easy-to-follow instructions"). Five parts,
// in the order an agent needs them: its goal in one line; what it looks
// at; its steps, in order; its rules, including when to do nothing and
// when to ask; and what it delivers, where and how it starts. The setup
// asks each part on its own (manual-agent.tsx); core keeps them as one
// text, Markdown under a heading a part, which is what the agent reads.

/** An agent's instructions, part by part, in the person's own words. */
export interface Brief {
  goal: string;
  look: string[];
  steps: string[];
  rules: string[];
  deliver: string;
}

export const briefParts = [
  "goal",
  "look",
  "steps",
  "rules",
  "deliver",
] as const;
export type BriefPart = (typeof briefParts)[number];

/** Each part's heading in the instructions, in the language they are written in. */
export const briefHeadings = {
  goal: msg`Goal`,
  look: msg`What to look at`,
  steps: msg`Steps`,
  rules: msg`Rules`,
  deliver: msg`What to deliver`,
} as const;

/** A starting point's brief, in the person's language. */
export const briefOf = (template: AgentTemplate, i18n: I18n): Brief => ({
  goal: i18n._(template.brief.goal),
  look: template.brief.look.map((line) => i18n._(line)),
  steps: template.brief.steps.map((line) => i18n._(line)),
  rules: template.brief.rules.map((line) => i18n._(line)),
  deliver: i18n._(template.brief.deliver),
});

const lastStop = /[.!?]$/u;

/**
 * The brief Grasp writes from someone's own words: their job as the goal,
 * and the steps, rules and delivery that make any agent careful, to change.
 */
export const ownBrief = (job: string, i18n: I18n): Brief => {
  const said = job.trim().replace(lastStop, "");
  return {
    goal: said === "" ? "" : `${said}.`,
    look: [i18n._(msg`What the person asking shares or names.`)],
    steps: [
      i18n._(msg`Find what is new or changed since the last time.`),
      i18n._(msg`Work out what matters most, and why.`),
      i18n._(msg`Draft anything that should be sent or changed.`),
    ],
    rules: [
      i18n._(
        msg`Never send or change anything yourself: leave it for a person to say yes to.`
      ),
      i18n._(
        msg`If something is unclear, ask one short question instead of guessing.`
      ),
      i18n._(msg`If there is nothing to do, say so in one line and stop.`),
    ],
    deliver: i18n._(
      msg`One short message: what you found first, then what you suggest.`
    ),
  };
};

/** The lines a part holds, one per line, without empty ones. */
export const linesOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Lines as a Markdown list. */
const bullets = (lines: readonly string[]): string =>
  lines.map((line) => `- ${line}`).join("\n");

/** Lines as a numbered Markdown list. */
const numbered = (lines: readonly string[]): string =>
  lines.map((line, at) => `${String(at + 1)}. ${line}`).join("\n");

/** The brief as the one text core keeps: Markdown, a heading a part, empty parts left out. */
export const instructionsOf = (brief: Brief, i18n: I18n): string => {
  const heading = (part: BriefPart) => `## ${i18n._(briefHeadings[part])}`;
  const parts: [BriefPart, string][] = [
    ["goal", brief.goal.trim()],
    ["look", bullets(brief.look)],
    ["steps", numbered(brief.steps)],
    ["rules", bullets(brief.rules)],
    ["deliver", brief.deliver.trim()],
  ];
  return parts
    .filter(([, body]) => body !== "")
    .map(([part, body]) => `${heading(part)}\n${body}`)
    .join("\n\n");
};
