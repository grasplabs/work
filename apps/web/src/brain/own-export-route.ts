import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { z } from "zod";

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

/**
 * Why core refused: its own error, with its code and reference, as RPC
 * errors carry them; or, for an answer that isn't one (a proxy's page),
 * `unexpected`, with no code: core out of reach, as a read takes it
 * (load-from-core.tsx).
 */
const refusalOf = async (
  response: Response,
  unexpected: string
): Promise<Error> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const payload = errorPayloadSchema.safeParse(body);
  if (!payload.success) {
    return new Error(unexpected);
  }
  const { code, message, details } = payload.data;
  return Object.assign(new Error(message), { code, details });
};

/**
 * The export the person's own store shows them: null when there is none.
 * An answer that isn't core's throws with no code: out of reach.
 */
export const readOwnExport = async (): Promise<OwnExport | null> => {
  const unexpected = "Core's answer about the export wasn't one it gives";
  const response = await fetch(ownExportPath, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw await refusalOf(response, unexpected);
  }
  const shown = shownSchema.safeParse(await response.json());
  if (!shown.success) {
    throw new Error(unexpected);
  }
  return shown.data.export;
};

/** Starts the person's own export, or meets the one being written. */
export const startOwnExport = async (unexpected: string): Promise<void> => {
  const response = await fetch(ownExportPath, { method: "POST" });
  if (!response.ok) {
    throw await refusalOf(response, unexpected);
  }
};

/** Where the browser downloads `file` of export `id`, on the person's session. */
export const ownExportFileHref = (id: string, file: string): string =>
  `${ownExportPath}?${new URLSearchParams({ id, file }).toString()}`;
