import type {
  DependencyFinding,
  DependencyPackageRef,
} from "@grasp-os/shared/dependencies";

// Lookalike package names (GRA-699): a package named so that a person
// reviewing a request reads it as a popular one, the usual typosquat. A
// heuristic, a finding for the approver, never proof either way: a
// package not flagged isn't shown to be what it seems.
//
// - Normalised alike: lowercase, `-`, `_` and `.` removed, it is a
//   popular name so normalised (`reactdom` for `react-dom`); and a scoped
//   name whose scope dropped is an unscoped popular one (`@evil/lodash`
//   for `lodash`). A popular scoped name keeps its scope: `@types/react`
//   isn't what `react`'s lookalikes look like.
// - One edit away from a popular name of at least `minEditedLength`
//   characters: a letter inserted, deleted, replaced, or two adjacent
//   letters swapped (`expresss`, `lodahs`). Shorter names are left out:
//   most short names are one edit from a popular one.
//
// A popular name itself is never flagged.

/**
 * npm's most depended-upon packages, by name, as typosquats target them:
 * a fixed list, read by no network call.
 */
export const popularPackages: readonly string[] = [
  "@babel/core",
  "@babel/runtime",
  "@types/node",
  "@types/react",
  "axios",
  "bluebird",
  "body-parser",
  "chalk",
  "cheerio",
  "classnames",
  "colors",
  "commander",
  "cookie-parser",
  "cors",
  "cross-env",
  "crypto-js",
  "date-fns",
  "dayjs",
  "debug",
  "decimal.js",
  "dotenv",
  "eslint",
  "express",
  "fs-extra",
  "glob",
  "graphql",
  "immer",
  "inquirer",
  "jquery",
  "js-yaml",
  "jsonwebtoken",
  "lodash",
  "lodash-es",
  "minimist",
  "mkdirp",
  "moment",
  "mongoose",
  "nanoid",
  "node-fetch",
  "nodemon",
  "papaparse",
  "prettier",
  "prop-types",
  "qs",
  "ramda",
  "react",
  "react-dom",
  "react-redux",
  "react-router",
  "react-router-dom",
  "redux",
  "request",
  "rimraf",
  "rxjs",
  "semver",
  "socket.io",
  "styled-components",
  "superagent",
  "tslib",
  "typescript",
  "underscore",
  "uuid",
  "validator",
  "webpack",
  "ws",
  "xml2js",
  "yargs",
  "zod",
];

/** The shortest popular name a one-edit lookalike is looked for against. */
const minEditedLength = 5;

/** `name` as lookalikes compare: lowercase, no `-`, `_` or `.`. */
export const normalisedName = (name: string): string =>
  name.toLowerCase().replaceAll(/[-_.]/gu, "");

/** `name` without its scope, if it has one. */
const unscoped = (name: string): string => name.replace(/^@[^/]+\//u, "");

/**
 * Whether `a` and `b` are at most one edit apart: equal, or one letter
 * inserted, deleted or replaced, or two adjacent letters swapped.
 */
export const oneEditApart = (a: string, b: string): boolean => {
  if (a === b) {
    return true;
  }
  if (Math.abs(a.length - b.length) > 1) {
    return false;
  }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start += 1;
  }
  const restA = a.slice(start);
  const restB = b.slice(start);
  if (a.length === b.length) {
    return (
      restA.slice(1) === restB.slice(1) ||
      (restA.length >= 2 &&
        restB.startsWith(`${restA.charAt(1)}${restA.charAt(0)}`) &&
        restA.slice(2) === restB.slice(2))
    );
  }
  return a.length > b.length
    ? restA.slice(1) === restB
    : restB.slice(1) === restA;
};

const popular: ReadonlySet<string> = new Set(popularPackages);

/** The popular name `name` looks like, or undefined. */
export const lookalikeOf = (name: string): string | undefined => {
  if (popular.has(name)) {
    return undefined;
  }
  // As it is, and, for a scoped name, as its unscoped part: each compared
  // with the popular names as they are, scoped or not.
  const forms = [
    ...new Set([normalisedName(name), normalisedName(unscoped(name))]),
  ];
  return popularPackages.find((known) => {
    const knownNormalised = normalisedName(known);
    return forms.some(
      (form) =>
        form === knownNormalised ||
        (knownNormalised.length >= minEditedLength &&
          oneEditApart(form, knownNormalised))
    );
  });
};

/** A finding for each package of `packages` named like a popular one. */
export const lookalikeFindings = (
  packages: readonly DependencyPackageRef[]
): DependencyFinding[] =>
  packages.flatMap((ref) => {
    const known = lookalikeOf(ref.name);
    return known === undefined
      ? []
      : [
          {
            kind: "lookalike" as const,
            package: { name: ref.name, version: ref.version },
            severity: "moderate" as const,
            id: null,
            summary: `Its name looks like ${known}'s, a popular package: check it is the one meant.`,
          },
        ];
  });
