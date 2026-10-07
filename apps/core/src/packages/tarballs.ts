import {
  fromBase64Url,
  sha512Integrity,
  toHex,
} from "@grasp-os/shared/encoding";
import { log } from "@grasp-os/shared/log";
import { packageErrors } from "@grasp-os/shared/packages";
import type { NpmTarballRequest } from "@grasp-os/shared/packages";

// npm tarballs as this deployment keeps them: in its own R2 bucket (in
// the EU), by the SHA-512 of their bytes, after connect fetched them and
// both connect and core checked them against that hash. Public packages
// only, and per deployment, so nothing of one client's is ever another's.
// A stored tarball is checked again each time it is read: one whose bytes
// no longer match is dropped and fetched again, never used.

/** Where a tarball is kept: by its SHA-512, in hex. */
const tarballKey = (integrity: string): string => {
  const digest = integrity
    .slice("sha512-".length)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `npm-tarballs/${toHex(fromBase64Url(digest))}.tgz`;
};

/**
 * One version's tarball, whose SHA-512 is `integrity`: from the store if
 * it is there and still those bytes, otherwise from the registry through
 * connect, and stored.
 */
export const verifiedTarball = async (
  env: Env,
  request: NpmTarballRequest
): Promise<Uint8Array> => {
  const key = tarballKey(request.integrity);
  const stored = await env.FILES.get(key);
  if (stored) {
    const bytes = new Uint8Array(await stored.arrayBuffer());
    if ((await sha512Integrity(bytes)) === request.integrity) {
      return bytes;
    }
    log.warn("packages.tarball_corrupt", {
      package: request.name,
      version: request.version,
    });
    await env.FILES.delete(key);
  }
  const fetched = await env.CONNECT.npmTarball(request);
  // Connect checked it; so does core, which keeps it.
  if ((await sha512Integrity(fetched)) !== request.integrity) {
    throw packageErrors.create("package.integrity_mismatch");
  }
  await env.FILES.put(key, fetched);
  return fetched;
};
