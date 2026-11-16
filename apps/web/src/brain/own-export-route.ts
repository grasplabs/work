import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { z } from "zod";

import { CoreTimeoutError, deadline, timeoutMs } from "../core.ts";

// A person's own export of what only they may read (GRA-1839), over core's
// route (core's brain-next-exports.ts): `GET` where it is, `POST` to start
// one, and each file a plain link the browser downloads on the person's
// session. Core answers only the signed-in person, about their own.

/** Where core serves a person's own export. */
export const ownExportPath = "/api/brain/own-export";

const ownExportSchema = z.object({
  id: z.uuid(),
  state: z.enum([
    "writing",
    "restoring",
    "done",
    "failed",
    "erased",
    "expired",
  ]),
  versions: z.int().nonnegative(),
  files: z.array(z.string()),
});

/** A person's own export, as core shows it to them. */
export type OwnExport = z.infer<typeof ownExportSchema>;

const shownSchema = z.object({ export: ownExportSchema.nullable() });

/** What an answer that isn't core's (a proxy's page) is taken for: core out of reach. */
const notCores = (): Error => new CoreTimeoutError(timeoutMs);

/**
 * Why core refused: its own error, with its code and reference, as RPC
 * errors carry them; or, for an answer that isn't one, `otherwise`.
 */
const refusalOf = async (
  response: Response,
  otherwise: () => Error
): Promise<Error> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const payload = errorPayloadSchema.safeParse(body);
  if (!payload.success) {
    return otherwise();
  }
  const { code, message, details } = payload.data;
  return Object.assign(new Error(message), { code, details });
};

/**
 * `init` sent to core's route within `signal`: one that ends (its deadline,
 * the page left) or a network that fails rejects as core out of reach
 * (`CoreTimeoutError`, our own words), as a read over RPC does.
 */
const sent = async (
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> => {
  try {
    return await fetch(ownExportPath, { ...init, signal });
  } catch {
    throw new CoreTimeoutError(timeoutMs);
  }
};

/**
 * The export the person's own store shows them: null when there is none.
 * Within `signal` (the read's, load-from-core.tsx: its deadline, or the
 * page left). An answer that isn't core's throws as core out of reach.
 */
export const readOwnExport = async (
  signal: AbortSignal
): Promise<OwnExport | null> => {
  const response = await sent(
    { headers: { accept: "application/json" } },
    signal
  );
  if (!response.ok) {
    throw await refusalOf(response, notCores);
  }
  const shown = shownSchema.safeParse(await response.json());
  if (!shown.success) {
    throw new CoreTimeoutError(timeoutMs);
  }
  return shown.data.export;
};

/**
 * Starts the person's own export, or meets the one being written, within
 * a few seconds (core.ts `deadline`).
 */
export const startOwnExport = async (): Promise<void> => {
  const response = await sent({ method: "POST" }, deadline());
  if (!response.ok) {
    throw await refusalOf(response, notCores);
  }
};

/** Where the browser downloads `file` of export `id`, on the person's session. */
export const ownExportFileHref = (id: string, file: string): string =>
  `${ownExportPath}?${new URLSearchParams({ id, file }).toString()}`;
