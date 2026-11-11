import type { ErrorCategory } from "@grasp-os/shared/error-categories";
import type { Json } from "@grasp-os/shared/json";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { isPlainObject } from "./value-descriptor.ts";

// The structured error a page's queries, mutations and actions fail
// with: what core answered, as it answered it, or why
// the session client refused or stopped before it had an answer. Never a
// transport envelope, a cause or a stack.

export type { ErrorCategory } from "@grasp-os/shared/error-categories";

/** What a structured SDK error carries. */
interface ErrorFields {
  readonly code: string;
  readonly message: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  /** The host's request ID to quote; null for the client's own errors. */
  readonly requestId: string | null;
  readonly details?: Json;
}

/**
 * A query, mutation or action that failed: what the host answered, or
 * why the client refused or stopped. Branch on `code`; `message` is for
 * people.
 */
export class GraspError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details: Json | undefined;

  constructor(fields: ErrorFields) {
    super(fields.message);
    this.name = "GraspError";
    this.code = fields.code;
    this.category = fields.category;
    this.retryable = fields.retryable;
    this.requestId = fields.requestId;
    this.details = fields.details;
  }
}

/** The client's own failures, by code: their message and category. */
const clientErrors = {
  "contract.invalid_args": {
    message: "The arguments don't fit the function.",
    category: "contract",
  },
  "contract.input_too_large": {
    message: "The arguments are larger than a function accepts.",
    category: "contract",
  },
  "contract.invalid_result": {
    message:
      "The save went through, but answered something other than the record it saved, so the form can't show the record as it is now.",
    category: "contract",
  },
  "contract.not_paginated": {
    message:
      "That query doesn't take a pagination argument and answer pages, so it can't be read as a paginated list.",
    category: "contract",
  },
  "contract.invalid_request": {
    message:
      "That isn't a public reference of this kind: use one from the App's generated api.",
    category: "contract",
  },
  "submission.key_invalid": {
    message:
      "That isn't a valid idempotency key: 1 to 128 printable ASCII characters.",
    category: "contract",
  },
  "query.cancelled": {
    message: "You stopped waiting for this query.",
    category: "operational",
  },
  "submission.cancelled": {
    message:
      "You stopped waiting for this change. It may still be saved: the platform keeps checking its outcome, and it won't be submitted twice.",
    category: "operational",
  },
  "submission.outcome_unknown": {
    message:
      "Whether this finished is unknown: no answer came back in time. Sending it again with the same idempotency key gets its outcome, and never runs it a second time.",
    category: "uncertain",
  },
  "stream.cancelled": {
    message:
      "You stopped following this action. The platform cancels it once no one follows it; what it already did stays done.",
    category: "operational",
  },
  "stream.outcome_unknown": {
    message:
      "The connection to this action was lost and couldn't be restored, so its outcome is unknown. It wasn't run again: run it again with the same idempotency key to get its outcome.",
    category: "uncertain",
  },
  "contract.mode_mismatch": {
    message:
      "That action streams its progress: run it with useStream or client.stream. Any other action runs with useAction or client.action.",
    category: "contract",
  },
  "stream.active": {
    message:
      "This stream is still running: wait for it to finish, or cancel it, before you run it again.",
    category: "contract",
  },
  "stream.unavailable": {
    message: "Streaming actions can't run here.",
    category: "operational",
  },
  "function.unreachable": {
    message: "The App's server couldn't be reached. Try again.",
    category: "operational",
  },
  "auth.unauthenticated": {
    message: "Sign in to continue.",
    category: "authorization",
  },
  "auth.principal_changed": {
    message:
      "Someone else signed in, so what was shown for the person before was cleared.",
    category: "authorization",
  },
  "form.failed": {
    message: "This couldn't be submitted.",
    category: "operational",
  },
  "form.uploading": {
    message: "A file is still uploading: wait for it, or cancel it.",
    category: "operational",
  },
  "contract.invalid_snapshot": {
    message:
      "The platform sent a run that doesn't fit its workflow's contract, so it isn't shown.",
    category: "contract",
  },
  "contract.mismatch": {
    message:
      "This run belongs to another version of the workflow's contract than this page was built for.",
    category: "contract",
  },
  "workflow.not_attached": {
    message:
      "No run is shown yet: start one, or wait for the selected run to load, before you control it.",
    category: "contract",
  },
  "file.operation_undeclared": {
    message:
      "This App doesn't declare that use of these files: add it to the files permission's operations.",
    category: "contract",
  },
  "file.upload_active": {
    message:
      "An upload is already running here: wait for it, or cancel it first.",
    category: "contract",
  },
  "file.channel_unavailable": {
    message: "Files can't be moved here.",
    category: "operational",
  },
  "file.cancelled": {
    message: "The upload was cancelled.",
    category: "operational",
  },
  "link.unavailable": {
    message: "Links can't be opened here.",
    category: "operational",
  },
  "decision.unavailable": {
    message:
      "Decisions can't be answered here: this page isn't running in Grasp's shell.",
    category: "contract",
  },
  "decision.outcome_unknown": {
    message:
      "Whether your answer was recorded is unknown: no answer came back. Give the same answer again to find out; it is never recorded twice.",
    category: "uncertain",
  },
} as const satisfies Record<
  string,
  { message: string; category: ErrorCategory }
>;

/** A failure the client itself decides on. */
type ClientErrorCode = keyof typeof clientErrors;

/**
 * The client's own failure `code`, with its `details`; and `message` in
 * place of its own, for a failure whose words are someone else's (a local
 * form's callback).
 */
export const clientError = (
  code: ClientErrorCode,
  details?: Json,
  message?: string
): GraspError =>
  new GraspError({
    code,
    ...clientErrors[code],
    ...(message === undefined ? {} : { message }),
    retryable: code === "function.unreachable",
    requestId: null,
    ...(details === undefined ? {} : { details }),
  });

/** A Standard Schema issue's path segment, a key or `{ key }`, as its key. */
export const issuePathKey = (
  segment: PropertyKey | StandardSchemaV1.PathSegment
): PropertyKey => (typeof segment === "object" ? segment.key : segment);

/**
 * `issues` as a refusal's details carry them: each one's message, its
 * path as keys and indexes, and its code when it has one.
 */
export const issueDetails = (
  issues: readonly (StandardSchemaV1.Issue & { readonly code?: string })[]
): Json[] =>
  issues.map(({ code, message, path }) => ({
    ...(code === undefined ? {} : { code }),
    message,
    path: (path ?? []).map((segment) => {
      const key = issuePathKey(segment);
      return typeof key === "number" ? key : String(key);
    }),
  }));

/** The issues a refusal's `details` carry (`issueDetails`), as read back. */
export const detailIssues = (
  details: Json | undefined
): StandardSchemaV1.Issue[] => {
  const issues = isPlainObject(details) ? details.issues : undefined;
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap((issue) => {
    if (!isPlainObject(issue) || typeof issue.message !== "string") {
      return [];
    }
    const path = Array.isArray(issue.path)
      ? issue.path.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number"
        )
      : [];
    return [{ message: issue.message, path }];
  });
};

/** Each uncertain failure's receipt link (`withReceiptLink`), by failure. */
const receiptLinks = new WeakMap<GraspError, () => Promise<unknown>>();

/**
 * `error`, an uncertain failure of a call that has an identity of its own
 * (a decision's answer), with a private link that sends
 * exactly that call again: the same answer to the same decision, never a
 * fresh one. A form keeps it to send the submission again under its
 * identity (form-binding.ts); nothing of it is on the error itself.
 */
export const withReceiptLink = (
  error: GraspError,
  again: () => Promise<unknown>
): GraspError => {
  receiptLinks.set(error, again);
  return error;
};

/** The link `withReceiptLink` gave `error`, if it gave it one. */
export const receiptLinkOf = (
  error: GraspError
): (() => Promise<unknown>) | undefined => receiptLinks.get(error);
