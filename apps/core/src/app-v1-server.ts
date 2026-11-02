import { appErrors, appV1ServerFolder } from "@grasp-os/shared/apps";

// The v1 App server is gone (GRA-789): no App code runs outside a sealed
// release, and nothing reads `app/server.ts` or `app/exports.json` any
// more. A version still holding them would look to whoever wrote it as if
// it served or exported something, while nothing of it ever runs, so it is
// refused as it is committed, naming the files, rather than kept unread.

/** Most paths the refusal names: enough to find them, bounded to send. */
const namedPathsMax = 20;

/** Refuses with `app.v1_server` paths under `app/`, naming them. */
export const refuseV1Server = (paths: Iterable<string>): void => {
  const v1 = [...paths]
    .filter((path) => path.startsWith(appV1ServerFolder))
    .toSorted();
  if (v1.length > 0) {
    throw appErrors.create("app.v1_server", {
      issues: v1.slice(0, namedPathsMax),
    });
  }
};
