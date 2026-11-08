import { isFileType } from "@grasp-os/shared/app-file-limits";
import type { FileDescription } from "@grasp-os/shared/app-file-limits";

import { isPlainObject } from "./value-descriptor.ts";

/** What core answers of an upload: its ID, state and the chunks it holds. */
export interface UploadState {
  readonly file: string;
  readonly state: "uploading" | "published" | "cancelled";
  readonly received: readonly number[];
}

const isState = (value: unknown): value is UploadState["state"] =>
  value === "uploading" || value === "published" || value === "cancelled";

export const readState = (value: unknown): UploadState => {
  if (
    !isPlainObject(value) ||
    typeof value.file !== "string" ||
    !isState(value.state) ||
    !Array.isArray(value.received)
  ) {
    throw new Error("Core's answer about an upload isn't one.");
  }
  const received = value.received.filter((index): index is number =>
    Number.isSafeInteger(index)
  );
  return { file: value.file, state: value.state, received };
};

export const readDescription = (value: unknown): FileDescription => {
  if (
    !isPlainObject(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !isFileType(value.mimeType) ||
    typeof value.size !== "number"
  ) {
    throw new Error("Core's answer about a file isn't one.");
  }
  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
  };
};
