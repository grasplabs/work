import type { ChatPlanKind } from "@grasp-os/shared/chat";
import type { Opportunity } from "@grasp-os/shared/opportunities";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useEffect, useRef } from "react";

import type { Session } from "../core.ts";
import { formatDecimal, formatList } from "../format.ts";
import type { Loaded } from "../load-from-core.tsx";

// Drafting from an opportunity an admin picks (GRA-1751), through the
// paths a builder already has, never one of its own: a workflow or an
// App is Make something's chat (`/?make=`), whose box the opportunity
// fills with a brief to change and send (chat/chat-start.tsx); a skill is
// the admin's own, written on Brain › Skills, whose editor it fills
// (skills-page.tsx), since a chat's agent never writes one. Nothing is
// asked of a model until the admin sends the brief, and the brief holds
// only what the opportunity's card shows them: its name, steps and the
// ones a person approves, its figures and the systems to connect first.

/** The opportunity `routine`, as the admin reads it now; none when it is gone. */
export const opportunityOf = async (
  session: Session,
  routine: string
): Promise<Opportunity | undefined> => {
  const listed = await session.opportunities.list();
  return listed.find((opportunity) => opportunity.routine === routine);
};

/**
 * Starts a draft from `opportunity` once it is read (`start`, given what
 * the admin reads of it now), and only once: never for one gone, or one
 * that couldn't be read.
 */
export const useStartFrom = (
  opportunity: Promise<Loaded<Opportunity | undefined>> | undefined,
  start: (read: Opportunity) => void
): void => {
  const started = useRef(false);
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const loaded = await opportunity;
      if (
        current &&
        !started.current &&
        loaded?.state === "ready" &&
        loaded.data !== undefined
      ) {
        started.current = true;
        start(loaded.data);
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [opportunity, start]);
};

/** Where an opportunity proposed as `form` is drafted: Make something's chat for an App or a workflow, Skills for a skill; none for a change or a connection alone. */
export const draftOf = (
  form: Opportunity["form"]
): { kind: ChatPlanKind } | { kind: "skill" } | null => {
  if (form === "workflow" || form === "app" || form === "skill") {
    return { kind: form };
  }
  return null;
};

/** A work's name as a title: starting with a capital, for display alone (it is named in lower case, as an activity: onboarding/team-map.ts). */
export const titleOf = (
  { name, local }: Pick<Opportunity, "name" | "local">,
  locale: string
): string => {
  const title = `${name.slice(0, 1).toLocaleUpperCase(locale)}${name.slice(1)}`;
  return local === undefined ? title : `${title} (${local})`;
};

/** Its steps, a line each, numbered, with the ones a person approves marked. */
const stepLinesOf = (
  { steps, personApproves }: Opportunity,
  i18n: I18n
): string[] => {
  const approves = new Set(personApproves);
  return steps.map((step, at) => {
    const number = at + 1;
    return approves.has(number)
      ? i18n._(msg`${number}. ${step} (a person approves this step)`)
      : `${number}. ${step}`;
  });
};

/** Its figures and what to connect first, a line each: only those it has. */
const figureLinesOf = (opportunity: Opportunity, i18n: I18n): string[] => {
  const lines: string[] = [];
  if (opportunity.casesPerWeek !== null) {
    const cases = formatDecimal(opportunity.casesPerWeek);
    lines.push(i18n._(msg`Cases a week: ${cases}.`));
  }
  if (opportunity.hoursPerWeek !== null) {
    const hours = formatDecimal(opportunity.hoursPerWeek);
    lines.push(i18n._(msg`Hours a week by hand: ${hours}.`));
  }
  if (opportunity.setup.length > 0) {
    const systems = formatList(opportunity.setup);
    lines.push(i18n._(msg`Connect first: ${systems}.`));
  }
  return lines;
};

/**
 * What Make something's box starts with for `opportunity`, drafted as
 * `kind`: what to make and from which opportunity, its steps, its
 * figures and what to connect first, for the admin to change and send.
 */
export const briefOf = (
  opportunity: Opportunity,
  kind: ChatPlanKind,
  i18n: I18n
): string => {
  const title = titleOf(opportunity, i18n.locale);
  const opening =
    kind === "app"
      ? i18n._(msg`Draft an App for the opportunity “${title}”.`)
      : i18n._(msg`Draft a workflow for the opportunity “${title}”.`);
  return [
    opening,
    i18n._(msg`How the team does it today:`),
    ...stepLinesOf(opportunity, i18n),
    ...figureLinesOf(opportunity, i18n),
  ].join("\n");
};

/** Most characters of a skill's name, as the SKILL.md format has it. */
const skillNameMaxLength = 64;

/** A skill's name from a routine's: lowercase letters, digits and hyphens, as a SKILL.md names it. */
const skillNameOf = (name: string): string =>
  name
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .slice(0, skillNameMaxLength)
    .replaceAll(/^-+|-+$/gu, "") || "routine";

/**
 * A SKILL.md for `opportunity`, as Skills' editor starts with it: a name
 * from the routine's, when to use it, and its steps, for the admin to
 * change and save as their own.
 */
export const skillOf = (opportunity: Opportunity, i18n: I18n): string => {
  const title = titleOf(opportunity, i18n.locale);
  const description = i18n._(msg`How we handle “${title}”, step by step.`);
  return [
    "---",
    `name: ${skillNameOf(opportunity.name)}`,
    // Quoted, as a title may hold a colon: JSON's string is YAML's too.
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `# ${title}`,
    "",
    ...stepLinesOf(opportunity, i18n),
  ].join("\n");
};
