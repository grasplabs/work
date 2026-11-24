// Builds what core's tests' global setup builds (apps/core/test/global-setup.ts:
// the App compiler, the extractor and the connect bundle) and keeps it by
// its inputs' key (apps/core/test/prebuilt.ts), with no test run: CI's
// test-caches job saves it on main, for the test shards to restore.
//
//   node scripts/build-core-test-prebuilt.ts
import setup from "../apps/core/test/global-setup.ts";

const teardown = await setup();
teardown();
