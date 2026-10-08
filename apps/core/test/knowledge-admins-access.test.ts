import { actorOf } from "@grasp-os/shared/audit";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { SessionApi } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mayRead } from "../src/knowledge/access.ts";
import { ensureCollection } from "../src/knowledge/collections.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

// A collection for admins (knowledge/access.ts): every admin reads it,
// Grasp staff included, and nobody else: not even who owns it, once they
// are no longer an admin. App sharing (app-provenance.ts) decides with
// `mayRead`, everything else with `readableBy`: both are tried here.

const idp = mockIdp();

/** Whether `api`'s person sees the collection `id` among theirs. */
const listed = async (api: SessionApi, id: string): Promise<boolean> => {
  const collections = await api.knowledge.listCollections();
  return collections.some((one) => one.id === id);
};

describe("a collection for admins", () => {
  it("is read by every admin, and by nobody else, its owner included", () => {
    const forAdmins = {
      access: "admins",
      owner: "owner",
      teamIds: [],
    } as const;
    expect(
      [
        { userId: "another-admin", teamIds: [], admin: true },
        { userId: "member", teamIds: ["ops"], admin: false },
        { userId: "owner", teamIds: [], admin: false },
      ].map((reader) => mayRead(reader, forAdmins))
    ).toStrictEqual([true, false, false]);
  });

  it("isn't listed for its owner once they are no longer an admin", async () => {
    const { api: member, userId } = await signedInApi(idp, "user");
    const id = collectionIdSchema.parse(`admins-${crypto.randomUUID()}`);
    // Made by the member back when they were an admin.
    await ensureCollection(
      env,
      {
        id,
        name: "For admins",
        description: "",
        owner: userId,
        access: "admins",
        sensitive: true,
        source: "upload",
        createdAt: new Date(),
      },
      actorOf({ userId, staff: false })
    );
    const { api: admin } = await signedInApi(idp, "admin");
    expect({
      owner: await listed(member, id),
      admin: await listed(admin, id),
    }).toStrictEqual({
      owner: false,
      admin: true,
    });
  });
});
