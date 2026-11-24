import type {
  DependencyFinding,
  DependencyPackageRef,
} from "@grasp-os/shared/dependencies";

// Lookalike package names (GRA-699): a package named so that a person
// reviewing a request reads it as a popular one, the usual typosquat. A
// heuristic, a finding for the approver, never proof either way: a
// package not flagged isn't shown to be what it seems.
//
// A name, and each of its squat forms (`js`, `.js` or `-js` dropped from
// its end, `node` from its start: `lodashjs`, `node-lodash`), looks like a
// popular name when, so compared, it is:
//
// - normalised alike: lowercase, `-`, `_` and `.` removed (`reactdom` for
//   `react-dom`). A popular scoped name keeps its scope: `@types/react`
//   isn't what `react`'s lookalikes look like;
// - or one edit away from a popular name of at least `minEditedLength`
//   characters: a letter inserted, deleted, replaced, or two adjacent
//   letters swapped (`expresss`, `lodahs`). Shorter names are left out:
//   most short names are one edit from a popular one.
//
// Both are `moderate`. A scoped name is compared by its unscoped part as
// well, the same way, but one whose unscoped part is a popular name
// exactly (`@emotion/react`) is only `info`: scopes name their packages
// after what they serve, and the scope shows whose it is.
//
// Never flagged: a popular name itself; a well-known package that merely
// sits one edit from one (`preact`, `tslint`), scoped or not; a package
// of the `@types` scope by its unscoped part, as DefinitelyTyped names
// each after the package it types (`@types/lodash`) and npm lets only
// DefinitelyTyped publish there.

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

/** Well-known packages of their own, one edit from a popular name. */
const knownDistinct: ReadonlySet<string> = new Set([
  "color",
  "colord",
  "inquire",
  "preact",
  "reach",
  "tslint",
]);

/** Scopes whose packages are named after the package they serve. */
const namedAfterScopes: ReadonlySet<string> = new Set(["@types"]);

/** `name`'s scope, `@types` for `@types/react`, or undefined. */
const scopeOf = (name: string): string | undefined =>
  /^(?<scope>@[^/]+)\//u.exec(name)?.groups?.scope;

/**
 * A normalised name and its squat forms: `js` dropped from its end
 * (`.js` and `-js` are normalised to it), `node` from its start, and both.
 */
const squatForms = (normalised: string): string[] => {
  const ends =
    normalised.length > "js".length && normalised.endsWith("js")
      ? [normalised, normalised.slice(0, -"js".length)]
      : [normalised];
  return ends.flatMap((form) =>
    form.length > "node".length && form.startsWith("node")
      ? [form, form.slice("node".length)]
      : [form]
  );
};

/** The popular name one of `forms` looks like, or undefined. */
const popularLike = (forms: readonly string[]): string | undefined =>
  popularPackages.find((known) => {
    const knownNormalised = normalisedName(known);
    return forms.some(
      (form) =>
        form === knownNormalised ||
        (knownNormalised.length >= minEditedLength &&
          oneEditApart(form, knownNormalised))
    );
  });

/**
 * What a name looks like: the popular name, and, when only its unscoped
 * part is that name exactly, the scope it is published under.
 */
export interface Lookalike {
  of: string;
  scope?: string;
}

/** What `name` looks like, or undefined when it looks like no popular name. */
export const lookalikeOf = (name: string): Lookalike | undefined => {
  if (popular.has(name) || knownDistinct.has(name)) {
    return undefined;
  }
  const whole = popularLike(squatForms(normalisedName(name)));
  if (whole !== undefined) {
    return { of: whole };
  }
  const scope = scopeOf(name);
  const bare = unscoped(name);
  if (
    scope === undefined ||
    namedAfterScopes.has(scope) ||
    knownDistinct.has(bare)
  ) {
    return undefined;
  }
  if (popular.has(bare)) {
    return { of: bare, scope };
  }
  const part = popularLike(squatForms(normalisedName(bare)));
  return part === undefined ? undefined : { of: part };
};

/** A finding for each package of `packages` named like a popular one. */
export const lookalikeFindings = (
  packages: readonly DependencyPackageRef[]
): DependencyFinding[] =>
  packages.flatMap((ref) => {
    const like = lookalikeOf(ref.name);
    if (like === undefined) {
      return [];
    }
    const finding = {
      kind: "lookalike" as const,
      package: { name: ref.name, version: ref.version },
      id: null,
    };
    return [
      like.scope === undefined
        ? {
            ...finding,
            severity: "moderate" as const,
            summary: `Its name looks like ${like.of}'s, a popular package: check it is the one meant.`,
          }
        : {
            ...finding,
            severity: "info" as const,
            summary: `Published under ${like.scope}, not the unscoped ${like.of}, a popular package: check it is the one meant.`,
          },
    ];
  });
