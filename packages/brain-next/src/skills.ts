import { parseDocument } from "yaml";
import { z } from "zod";

import { holdsTerm, termsOf, wordsOf } from "./words.ts";

// Skills: how things are done, as `SKILL.md` documents in the Agent Skills
// format (a YAML frontmatter block holding at least `name` and
// `description`, then the instructions). The store keeps each as a
// source of its own, whole, like an instruction file (contract.ts
// `addInstructions`): never cut into chunks, so recall never returns one.
// What a host may select from is its own to say; this file only reads a
// skill's card from its text and ranks cards for a task, the same way
// for every word, with no model.

/**
 * A skill's name, as the Agent Skills format has it: lowercase letters,
 * digits and single hyphens, at most 64 characters.
 */
export const skillNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

/** Most characters of a skill's description, as the format has it. */
export const skillDescriptionMaxLength = 1024;

/** Control characters, line breaks among them. */
const controlCharacters = /\p{Cc}/u;

const frontmatterSchema = z.looseObject({
  name: skillNameSchema,
  // One line: a description is listed in every chat's prompt, where a
  // line break could close the list and start text of its own.
  description: z
    .string()
    .trim()
    .min(1)
    .max(skillDescriptionMaxLength)
    .refine((description) => !controlCharacters.test(description)),
});

/** A skill as a selection weighs it: its name and when to use it. */
export interface SkillCard {
  name: string;
  description: string;
}

/** The frontmatter block at the top of a `SKILL.md`, and the line it ends on. */
const frontmatterBlock = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/**
 * The frontmatter `text` declares (YAML, read by a YAML parser, never by
 * hand), whole, when it holds a card: null when it holds none, the YAML
 * doesn't parse or expands past the parser's bound on aliases, or its name
 * or description isn't the format's. What else it holds is the host's to
 * read (a host's own fields, such as what a skill needs).
 */
export const skillFrontmatterOf = (
  text: string
): (SkillCard & Readonly<Record<string, unknown>>) | null => {
  const yaml = frontmatterBlock.exec(text)?.groups?.yaml;
  if (yaml === undefined) {
    return null;
  }
  const document = parseDocument(yaml, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return null;
  }
  let value: unknown;
  try {
    // Throws past the parser's bound on aliases (`maxAliasCount`): a few
    // lines of anchors and aliases can otherwise expand without end.
    value = document.toJS();
  } catch {
    return null;
  }
  const parsed = frontmatterSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** The card `text` declares in its frontmatter (`skillFrontmatterOf`), or null. */
export const skillCardOf = (text: string): SkillCard | null => {
  const frontmatter = skillFrontmatterOf(text);
  return frontmatter === null
    ? null
    : { name: frontmatter.name, description: frontmatter.description };
};

/** Most skills a selection answers. */
export const skillsSelectedMax = 5;

/**
 * The cards of `cards` that apply to `task`, best first, at most
 * `skillsSelectedMax`: those whose name or description holds at least one
 * of the task's telling words in any of its forms, as recall's words way
 * matches them (words.ts), more of them first, then by name. A task of
 * stop words alone weighs those. None for a task no card shares a word
 * with: a skill that only seems close is never picked.
 */
export const selectSkills = <Card extends SkillCard>(
  task: string,
  cards: readonly Card[]
): Card[] => {
  const { telling } = termsOf(task);
  if (telling.length === 0) {
    return [];
  }
  return (
    cards
      .map((card) => {
        // A name's hyphens separate its words, as a word index reads them.
        const words = wordsOf(`${card.name} ${card.description}`);
        const held = telling.filter((term) => holdsTerm(words, term)).length;
        return { card, held };
      })
      .filter(({ held }) => held > 0)
      // Names are lowercase ASCII letters, digits and hyphens: any
      // collation orders them alike.
      .toSorted(
        (a, b) => b.held - a.held || a.card.name.localeCompare(b.card.name)
      )
      .slice(0, skillsSelectedMax)
      .map(({ card }) => card)
  );
};
