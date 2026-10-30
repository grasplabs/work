import type { LandscapeApp, PolicyDocument } from "@grasp-os/shared/brain";
import type { LandscapeAppSummary } from "@grasp-os/shared/landscape";
import type { PolicyDocument as PolicyManagerDocument } from "@grasp-os/shared/policies";

import { landscapeAppsOf } from "./landscape.ts";
import { readBook } from "./policies.ts";

// The brain's landscape and policies (`brain.read`), from what the
// landscape (landscape.ts) and the policy manager (policies.ts) keep,
// each as anyone signed in reads it there: the apps people granted access
// through the organization's identity provider, and the policy documents
// with what Grasp read out of them. The brain's app notes and policy notes
// are drawn from these.

/** An ISO 8601 moment to the minute, as the brain keeps policy times. */
const minuteOf = (iso: string): string => iso.slice(0, 16);

/**
 * A landscape app as the brain shows one. The landscape reads Microsoft's
 * directory alone, so an app is seen through Microsoft sign-in; its vendor
 * is only a publisher the provider verified; what kind of AI it is, its
 * category and the team owning it, the landscape doesn't know.
 */
export const brainLandscapeApp = (app: LandscapeAppSummary): LandscapeApp => ({
  id: app.appId,
  name: app.name,
  vendor: app.verified ? (app.publisher ?? "") : "",
  category: "",
  ai: "none",
  people: app.people,
  seenThrough: ["microsoftSso"],
  owner: null,
  matches: [app.name],
  permissions: app.scopes,
});

/** A policy as the brain shows one: what the policy manager read of it. */
export const brainPolicy = (policy: PolicyManagerDocument): PolicyDocument => ({
  id: policy.id,
  title: policy.title,
  uploadedAt: minuteOf(policy.uploadedAt),
  status: policy.status,
  ...(policy.summary === undefined ? {} : { summary: policy.summary }),
  proposals: policy.proposals.map(({ excerpt, decision }) => ({
    excerpt,
    decision,
  })),
  unchecked: policy.unchecked.map(({ excerpt }) => ({ excerpt })),
  ...(policy.publishedAt === undefined
    ? {}
    : { publishedAt: minuteOf(policy.publishedAt) }),
});

/**
 * The landscape's apps, each once (an app two connections see is the
 * same app), and the policies, newest first.
 */
export const brainLandscapeAndPolicies = async (
  env: Env,
  now: Date
): Promise<{ landscape: LandscapeApp[]; policies: PolicyDocument[] }> => {
  const [apps, book] = await Promise.all([
    landscapeAppsOf(env, now),
    readBook(env),
  ]);
  const landscape = [
    ...new Map(apps.map((app) => [app.appId, brainLandscapeApp(app)])).values(),
  ];
  return { landscape, policies: book.policies.map(brainPolicy) };
};
