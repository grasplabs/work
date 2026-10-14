import { defineSchema } from "@grasp-os/sdk";

// The intake keeps its records in the Playbook (app/records.json), not in
// a store: its registration (app.ts) only declares what its workflows use.
export default defineSchema({});
