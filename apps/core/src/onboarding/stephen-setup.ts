import type { KickoffView, VisionField } from "@grasp-os/shared/kickoff";
import { interviewLocales } from "@grasp-os/shared/onboarding";
import type {
  StephenSetup,
  StephenSetupView,
} from "@grasp-os/shared/onboarding-staff";

import { kickoffBrief } from "./kickoff.ts";
import { NAMED } from "./stephen.ts";

// How Stephen is set up for one deployment (GRA-320), as in the
// prototype's "How he is set up" (`components/admin/org-stephen.tsx`,
// `StephenSetup`): the languages he interviews in, what he leaves alone,
// and the words he has to know. Until staff set it, it is what the kickoff
// suggests; once they do, theirs holds, from the next turn on. It goes
// into every interview turn's context (`interviewBrief`) together with
// what the kickoff brought, where staff's setup takes the place of the
// kickoff's own word on languages and on what to leave alone. Pure, so
// tested through the store that calls it.

/** One line as a list takes it: whitespace as one space. */
const line = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

/**
 * `lines`, without empty ones or repeats. Never cut: the setup's lists
 * take a whole sponsor's answer and every team a kickoff names, so what
 * staff save unchanged is what the kickoff said.
 */
const listOf = (lines: (string | undefined)[]): string[] => [
  ...new Set(lines.map((each) => line(each ?? "")).filter(Boolean)),
];

/**
 * What the kickoff suggests: every language he speaks (someone chooses
 * theirs when they open their link), what it said to leave alone and the
 * sponsor's answer about it, and the teams it named as words to know.
 */
export const suggestedSetup = ({
  reading,
  answers,
}: Pick<KickoffView, "reading" | "answers">): StephenSetup => ({
  languages: [...interviewLocales],
  limits: listOf([reading?.fields.limits?.text, answers.limits]),
  terms: listOf((reading?.teams ?? []).map(({ name }) => name)),
});

/** What the kickoff said of `field`, or the sponsor's answer to it. */
const saidOf = (
  { reading, answers }: Pick<KickoffView, "reading" | "answers">,
  field: VisionField
): string | null => {
  const said = [reading?.fields[field]?.text, answers[field]]
    .map((each) => each?.trim() ?? "")
    .filter((each) => each !== "");
  return said.length === 0 ? null : said.join(" ");
};

/** Stephen's setup as staff see it: `stored` when they set one. */
export const setupView = (
  stored: StephenSetup | null,
  kickoff: Pick<KickoffView, "reading" | "answers">
): StephenSetupView => {
  const suggested = suggestedSetup(kickoff);
  return {
    setup: stored ?? suggested,
    changed: stored !== null,
    suggested,
    kickoff: {
      languages: saidOf(kickoff, "languages"),
      systems: saidOf(kickoff, "systems"),
    },
  };
};

/** What the setup tells Stephen, under its headings. */
const setupBrief = ({ languages, limits, terms }: StephenSetup): string =>
  [
    "# How you are set up for this company",
    `## The languages you interview in\n${languages.map((locale) => NAMED[locale]).join(", ")}`,
    ...(limits.length === 0
      ? []
      : [
          `## What you leave alone: never ask about it, and move on when someone brings it up\n${limits.map((each) => `- ${each}`).join("\n")}`,
        ]),
    ...(terms.length === 0
      ? []
      : [
          `## Words you have to know, so you hear them right\n${terms.join(", ")}`,
        ]),
  ].join("\n\n");

/**
 * What every interview turn's context holds of the company before anyone
 * says a word: how Stephen is set up (staff's, or what the kickoff
 * suggests) and what the kickoff brought. Staff's setup speaks for the
 * languages and what to leave alone, so the kickoff's word on them goes;
 * until staff set him up, the kickoff's own word on them stays.
 */
export const interviewBrief = (
  stored: StephenSetup | null,
  kickoff: Pick<KickoffView, "reading" | "answers">
): string => {
  const { setup } = setupView(stored, kickoff);
  const brought = kickoffBrief(
    kickoff.reading,
    kickoff.answers,
    stored === null ? [] : ["languages", "limits"]
  );
  return [setupBrief(setup), brought].filter(Boolean).join("\n\n");
};
