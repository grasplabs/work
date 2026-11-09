import { createIdp } from "../fake-idp.ts";
import { jsonWorkflowAppsOf } from "../json-workflow-apps.ts";

// What workflow-run-sessions*.test.ts share: the IdP, who signs in, the
// model a run calls and how long a run may take. Each file has the IdP
// answer for its own tests (`mockIdpWith`).

export const idp = createIdp();
export const { signedIn } = jsonWorkflowAppsOf(idp);

export const extractionModel = "mistral/mistral-large-latest";

/** A load of each run here may wait out a full sandbox: room for a slow runner. */
export const runTime = { timeout: 90_000 };
