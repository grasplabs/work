import type { DirectoryReadFailure } from "@grasp-os/shared/directory";

/**
 * What an admin can do about the directory's daily reads failing:
 * `connect`, have an administrator of their own organization connect it
 * again; `tooLarge`, ask Grasp's support; `wait`, nothing yet: the next
 * try, a quarter of an hour later, mends what passes.
 */
export type ReadAdvice = "connect" | "tooLarge" | "wait";

/**
 * What an admin can do about reads failing with `code`: every code a read
 * records has its place, so a new one fails to type-check until it is
 * given one.
 */
export const adviceOf = (code: DirectoryReadFailure): ReadAdvice => {
  switch (code) {
    // No connection (disconnected since the last read), one that can't be
    // read with (Google's answer to an account that isn't the Workspace's
    // admin among them), or another organization's.
    case "directory.not_connected":
    case "directory.inactive":
    case "directory.not_admin":
    case "directory.not_found":
    case "directory.other_tenant": {
      return "connect";
    }
    case "directory.too_large": {
      return "tooLarge";
    }
    // What passes: throttling, a provider that didn't answer, a read that
    // ran out of time, or a failure past the deleted list's first page.
    case "directory.cursor_invalid":
    case "directory.throttled":
    case "directory.provider_failed":
    case "directory.read_too_long":
    case "directory.read_failed":
    case "directory.deleted_refused":
    case "directory.deleted_unsupported": {
      return "wait";
    }
    default: {
      const unplaced: never = code;
      return unplaced;
    }
  }
};
