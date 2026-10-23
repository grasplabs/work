/**
 * The Cloudflare Access team and application the tests' admin trusts.
 * Imported by vite.test.config.ts (Node) and the tests (workerd), so it only
 * holds data.
 */
export const accessTeam = {
  issuer: "https://grasp-test.cloudflareaccess.com",
  audience: "test-admin-aud",
} as const;
