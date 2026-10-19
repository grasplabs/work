import { defineSchema, defineTable, v } from "@grasp-os/sdk";

/** The greetings the App has given, one row each. */
export default defineSchema({
  greetings: defineTable({ name: v.string().min(1).max(200) }),
});
