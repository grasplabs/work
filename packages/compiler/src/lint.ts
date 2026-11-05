/**
 * Lints App screens and components with @shadcn/lint's rules and Grasp's
 * own (design-rules.ts), as the repo lints its own code, through ESLint's
 * `Linter` (which needs no file system of its own) and oxc's parser
 * (eslint-parser.ts). Part of the lint isolate's lint (ultracite-worker.ts), so
 * what it finds blocks a proposal, not a build or a preview, as an
 * exported App's oxlint reports it beside every other rule.
 *
 * The rules read the project from disk: `components.json`, the theme and
 * the kit's component sources, for their variants, and the App's own
 * components a screen wraps the kit's in. Each lint writes them
 * (`DesignKit.lintProject`, and the App's screens and components) to
 * `/tmp`, which in a Worker belongs to the request: concurrent lints
 * don't see each other's files.
 *
 * Its comments are read as an exported App's oxlint reads them
 * (lint-comments.ts): `oxlint-disable…` too, a disable comment for a rule
 * another lint runs passes over, and inline config comments don't count.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { plugin as shadcn } from "@shadcn/lint";
import { Linter } from "eslint/universal";

import { designRuleLevels, designRules } from "./design-rules.ts";
import type { Diagnostic } from "./diagnostic.ts";
import {
  isUnparsable,
  orUnparsable,
  parser,
  unparsableMessage,
} from "./eslint-parser.ts";
import { isDesignLinted } from "./inputs.ts";
import { asEslint, namesUnknownRule, placeIn } from "./lint-comments.ts";
import type { Place } from "./lint-comments.ts";

/** What the design lint reads of the kit, which build.ts works out (`#design-kit`). */
export interface DesignKit {
  /**
   * The kit as the rules read it from disk, by path relative to the App:
   * `components.json`, the theme and the kit's component sources.
   */
  lintProject: Record<string, string>;
  /** The rules of @shadcn/lint, as the repo lints with them. */
  lintRules: Linter.RulesRecord;
}

const root = "/tmp/app";

/**
 * Added to every message: an App uses the kit as it is. An exported App's
 * oxlint adds it too (scripts/package-definition-lib.ts).
 */
export const designNote =
  "Screens can't change the kit (@grasp-os/ui): use what it has, or build the look from plain elements.";

const writeFiles = (files: Record<string, string>): void => {
  for (const [path, content] of Object.entries(files)) {
    const file = `${root}/${path}`;
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    writeFileSync(file, content);
  }
};

/** What a file the parser couldn't read says: an error, so it never passes unlinted. */
const unparsable = (file: string): Diagnostic[] => [
  { file, rule: "lint", severity: "error", message: unparsableMessage },
];

const toDiagnostic = (
  file: string,
  place: Place,
  message: Linter.LintMessage
): Diagnostic => {
  const diagnostic: Diagnostic = {
    file,
    ...place,
    rule: message.ruleId ?? "lint",
    severity: message.severity === 2 ? "error" : "warning",
    message: message.message,
  };
  const [suggestion] = message.suggestions ?? [];
  if (suggestion !== undefined) {
    diagnostic.fix = suggestion.desc;
  }
  return diagnostic;
};

/**
 * What the design lint says of each of `files`' screens and components
 * (`isDesignLinted`), by path relative to the App, against `kit`, with
 * `app`, the App's screens and components, on disk for the rules to read.
 * Nothing of a file that doesn't parse: oxlint's lint says nothing of it
 * either, and the build says why.
 */
export const lintDesign = (
  files: Record<string, string>,
  app: Record<string, string>,
  kit: DesignKit
): Record<string, Diagnostic[]> => {
  writeFiles({ ...kit.lintProject, ...app, ...files });
  const linter = new Linter({ cwd: root });
  const config: Linter.Config[] = [
    {
      files: ["**/*.ts", "**/*.tsx"],
      languageOptions: {
        parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      // A disable comment for one of the other lints' rules, which don't
      // run here, would read as unused.
      linterOptions: { reportUnusedDisableDirectives: "off" },
      plugins: { shadcn, grasp: designRules },
      settings: { shadcn: { note: designNote } },
      rules: { ...kit.lintRules, ...designRuleLevels },
    },
  ];
  const linted = (path: string, source: string): Diagnostic[] => {
    const { text, changes } = asEslint(path, source);
    const place = placeIn(source, text, changes);
    const messages = linter.verify(text, config, `${root}/${path}`);
    if (messages.some((message) => isUnparsable(message))) {
      return unparsable(path);
    }
    return messages
      .filter((message) => message.fatal !== true && !namesUnknownRule(message))
      .map((message) => toDiagnostic(path, place(message), message));
  };
  return Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => isDesignLinted(path))
      .map(([path, source]) => [
        path,
        orUnparsable(
          () => linted(path, source),
          () => unparsable(path)
        ),
      ])
  );
};
