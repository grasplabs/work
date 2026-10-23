/**
 * Grasp's Discord application as the tests' admin knows it: the Ed25519
 * key a stand-in for Discord signs interactions with (RFC 8032's first test
 * vector: its seed, and its public half as Discord shows an application's
 * key), and the staff it answers. Imported by vite.test.config.ts (Node),
 * which gives the admin the public key, and by the tests (workerd), so it
 * only holds data. A published test key, never Discord's.
 */
export const discordTest = {
  signingSeed:
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  staffIds: ["111111111111111111", "222222222222222222"],
} as const;
