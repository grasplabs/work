/**
 * Lints App files with @shadcn/lint's rules, as the repo lints its own
 * code, through ESLint's `Linter` (which needs no file system of its own)
 * and the typescript-eslint parser, on TypeScript 6, the last with a
 * JavaScript API: the lint's parser alone, never the type check's (tsrs).
 *
 * The rules read the project from disk: `components.json`, the theme and
 * the kit's component sources, for their variants. Each lint writes them
 * (`Kit.lintProject`) and the App's files to `/tmp`, which in a Worker
 * belongs to the request: concurrent lints don't see each other's files.
 *
 * Its comments are read as an exported App's oxlint reads them
 * (lint-comments.ts): `oxlint-disable…` too, a disable comment for a rule
 * another lint runs passes over, and inline config comments don't count.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { plugin as shadcn } from "@shadcn/lint";
import * as parser from "@typescript-eslint/parser";
import { Linter } from "eslint/universal";

import { designRuleLevels, designRules } from "./design-rules.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { declarationExtension } from "./inputs.ts";
import type { Kit } from "./kit.ts";
import {
  asEslint,
  namesUnknownRule,
  placeIn,
  ruleIndex,
} from "./lint-comments.ts";
import type { Place } from "./lint-comments.ts";

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

/** Lints App files (by path relative to the App) against the kit. */
export const lint = (
  appFiles: Record<string, string>,
  kit: Kit
): Diagnostic[] => {
  writeFiles({ ...kit.lintProject, ...appFiles });
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
  // Every rule here is a JS plugin's in oxlint.
  const rules = ruleIndex([], Object.keys(config[0]?.rules ?? {}));
  return Object.entries(appFiles)
    .filter(([path]) => !path.endsWith(declarationExtension))
    .flatMap(([path, source]) => {
      const { text, changes } = asEslint(path, source, rules);
      const place = placeIn(source, text, changes);
      return linter
        .verify(text, config, `${root}/${path}`)
        .filter((message) => !namesUnknownRule(message))
        .map((message) => toDiagnostic(path, place(message), message));
    });
};
