import { directoryReadFailures } from "@grasp-os/shared/directory";
import type { DirectoryReadFailure } from "@grasp-os/shared/directory";
import { describe, expect, it } from "vite-plus/test";

import { adviceOf } from "./directory-read-advice.ts";
import type { ReadAdvice } from "./directory-read-advice.ts";

// What Settings › Members tells an admin to do about the directory's
// daily reads failing, for every failure a read records: connecting again
// only where a connection is what fails, never "wait" for one.

const expected: Record<DirectoryReadFailure, ReadAdvice> = {
  "directory.inactive": "connect",
  "directory.not_admin": "connect",
  "directory.not_found": "connect",
  "directory.other_tenant": "connect",
  "directory.too_large": "tooLarge",
  "directory.cursor_invalid": "wait",
  "directory.throttled": "wait",
  "directory.provider_failed": "wait",
  "directory.read_too_long": "wait",
  "directory.read_failed": "wait",
  "directory.deleted_refused": "wait",
  "directory.deleted_unsupported": "wait",
};

describe("the advice for a failing directory read", () => {
  it("tells an admin to connect again only where the connection fails, to ask for help with a directory too large, and otherwise to wait for the next try", () => {
    expect(
      Object.fromEntries(
        directoryReadFailures.map((code) => [code, adviceOf(code)])
      )
    ).toStrictEqual(expected);
  });
});
