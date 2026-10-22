import type { ValueDescriptor } from "@grasp-os/sdk";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { runFileErrors, runFileLimits } from "@grasp-os/shared/run-files";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  copyIntoRun,
  startFilesAdmitted,
  startFilesDropped,
} from "./run-files.ts";
import type { RunFileSource } from "./run-files.ts";

// The files a start hands its run (GRA-885): each `file` value (`v.file()`,
// `{ id }`) of a start's input names a file of the App whose screen starts
// it, read as the person it acts for may read it now, and copied into the
// run's own files before the start is admitted. The run's input keeps the
// value's shape, `{ id }`, now naming its run file, read through the
// workflow's own `files` binding. Threat note on GRA-885:
//
// - Only an App's screen hands a run a file (`StartFiles`, which only
//   screen-workflows.ts builds). Any other start holding a `file` value is
//   refused (`file.start_files`): no store to take it from.
// - Which files, and whether the person may read each, is the App's store
//   to say (`StartFiles.read`), with their roles now: core copies only
//   what that answers, by its recorded chunks.
// - A copy is no run's file until the start is admitted: the admitting
//   batch marks it done, with its audit event, only once the start's
//   receipt is written (`admitted`). A start never admitted drops its
//   copies, or the sweep does.

/** A file of the App, as the person may read it now: what is copied. */
export interface StartFile extends RunFileSource {
  readonly id: string;
  /** Who uploaded it. */
  readonly ownerId: string;
}

/**
 * The App files a start may hand its run: given only for a start an App's
 * screen makes, acting for the person using it.
 */
export interface StartFiles {
  /** File `fileId`, if the person may read it now: `file.not_found` otherwise. */
  readonly read: (fileId: string) => Promise<StartFile>;
  /**
   * The audit event of `file` handed to run `runId` of workflow
   * `workflowId`, written only while `admitted` holds.
   */
  readonly sent: (
    file: StartFile,
    runId: string,
    workflowId: string,
    admitted: SQL
  ) => BatchItem<"sqlite">;
}

type Path = readonly (string | number)[];

type JsonObject = Readonly<Record<string, Json | undefined>>;

// `Array.isArray` doesn't narrow a readonly array type.
const isJsonArray = (value: Json): value is readonly Json[] =>
  Array.isArray(value);

/** `value` as an object, if it is one (not an array, not null). */
const objectOf = (value: Json | undefined): JsonObject | undefined =>
  value === null ||
  value === undefined ||
  typeof value !== "object" ||
  isJsonArray(value)
    ? undefined
    : value;

/** Whether a value under `descriptor` can hold a `file` value anywhere. */
export const holdsFile = (descriptor: ValueDescriptor): boolean => {
  if (descriptor.kind === "file") {
    return true;
  }
  if (descriptor.kind === "object") {
    return Object.values(descriptor.fields).some(holdsFile);
  }
  if (descriptor.kind === "array") {
    return holdsFile(descriptor.item);
  }
  if (descriptor.kind === "record") {
    return holdsFile(descriptor.value);
  }
  return descriptor.kind === "union" && descriptor.members.some(holdsFile);
};

/** The `file` values of `value` under `descriptor`: where each is, and its ID. */
export const fileSlots = (
  descriptor: ValueDescriptor,
  value: Json
): { path: Path; id: string }[] => {
  const found: { path: Path; id: string }[] = [];
  const walk = (at: ValueDescriptor, here: Json, path: Path): void => {
    if (at.kind === "file") {
      const id = objectOf(here)?.id;
      if (typeof id === "string") {
        found.push({ path, id });
      }
    } else if (at.kind === "object") {
      const fields = objectOf(here);
      for (const [name, field] of Object.entries(at.fields)) {
        const inner = fields?.[name];
        if (inner !== undefined) {
          walk(field, inner, [...path, name]);
        }
      }
    } else if (at.kind === "array") {
      if (isJsonArray(here)) {
        for (const [index, item] of here.entries()) {
          walk(at.item, item, [...path, index]);
        }
      }
    } else if (at.kind === "record") {
      for (const [key, inner] of Object.entries(objectOf(here) ?? {})) {
        if (inner !== undefined) {
          walk(at.value, inner, [...path, key]);
        }
      }
    } else if (at.kind === "union" && at.members.some(holdsFile)) {
      // Which member a value is, is the checker's to say, not this
      // walk's: a file under a union is never guessed at.
      throw runFileErrors.create("file.start_files");
    }
  };
  walk(descriptor, value, []);
  return found;
};

/** `value` with the value at `path` replaced by `replacement`. */
const replacedAt = (value: Json, path: Path, replacement: Json): Json => {
  const [first, ...rest] = path;
  if (first === undefined) {
    return replacement;
  }
  if (isJsonArray(value) && typeof first === "number") {
    return value.map((item, index) =>
      index === first ? replacedAt(item, rest, replacement) : item
    );
  }
  const fields = objectOf(value);
  const inner = fields?.[String(first)];
  return fields === undefined || inner === undefined
    ? value
    : { ...fields, [first]: replacedAt(inner, rest, replacement) };
};

/** What a start hands its run: its input as the run reads it, and what admits the copies. */
export interface HandedFiles {
  /** The run's input, canonical JSON: each file value naming its run file. */
  readonly input: string;
  /** The ID its run must be admitted under, when it copied any file. */
  readonly runId: string | undefined;
  /** Run in the admitting batch, while `admitted` holds: the copies done, and audited. */
  readonly admitted: ((admitted: SQL) => BatchItem<"sqlite">[]) | undefined;
}

/**
 * Copies the files of `input` (canonical JSON, checked against
 * `descriptor`) into run `runId` of workflow `workflowId`, through
 * `files`: none when it holds none. `file.start_files` when it holds a
 * file but no App's screen starts it, no run is admitted with it, or
 * more than a start hands its run. The input as it is when it holds none.
 */
export const handFiles = async (
  env: Env,
  descriptor: ValueDescriptor,
  input: string,
  target: {
    readonly runId: string;
    readonly workflowId: string;
    /** Whether a run is admitted with the start: none, nothing to hand a file to. */
    readonly runs: boolean;
  },
  files: StartFiles | undefined
): Promise<HandedFiles> => {
  const value = z.json().parse(JSON.parse(input));
  const slots = fileSlots(descriptor, value);
  if (slots.length === 0) {
    return { input, runId: undefined, admitted: undefined };
  }
  if (
    files === undefined ||
    !target.runs ||
    slots.length > runFileLimits.startFiles
  ) {
    throw runFileErrors.create("file.start_files");
  }
  let handed: Json = value;
  const copied: StartFile[] = [];
  try {
    for (const [slot, { path, id }] of slots.entries()) {
      // One after another: each is read as the person may read it now.
      // oxlint-disable-next-line no-await-in-loop -- one copy at a time
      const file = await files.read(id);
      // oxlint-disable-next-line no-await-in-loop -- one copy at a time
      const runFile = await copyIntoRun(env, target, slot, file);
      copied.push(file);
      handed = replacedAt(handed, path, { id: runFile });
    }
    // Read again once all are copied, just before the start is admitted:
    // a file hidden from the person, or a role they lost, during a long
    // copy refuses the start, its copies with it.
    for (const { id } of slots) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time
      await files.read(id);
    }
  } catch (error) {
    // What it copied before the one it couldn't is no run's either.
    await startFilesDropped(env, target.runId);
    throw error;
  }
  return {
    input: canonicalJson(handed),
    runId: target.runId,
    // Statements of the admitting batch, never run on their own.
    admitted: (admitted) => [
      startFilesAdmitted(drizzle(env.DB), target.runId, admitted),
      ...copied.map((file) =>
        files.sent(file, target.runId, target.workflowId, admitted)
      ),
    ],
  };
};
