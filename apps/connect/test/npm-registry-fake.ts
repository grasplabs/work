/**
 * The npm registry (https://registry.npmjs.org), as strict as the real
 * one where Grasp depends on it: a package's metadata (its "packument",
 * with `versions`, `time`, `dist-tags` and each version's `dist`) at
 * `/<name>` (a scope's slash encoded), each tarball at
 * `/<name>/-/<base>-<version>.tgz`, a JSON 404 for anything it doesn't
 * have, and real tarballs: ustar archives under `package/`, gzipped, whose
 * SHA-512 the metadata names as npm does (`sha512-<base64>`). A test
 * publishes packages, can hand-craft a tarball's entries (links, paths
 * that climb out, PAX headers, gigabytes of zeros), make the registry
 * redirect or answer something else for a path, and reads back what was
 * asked.
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (core's test/connect-providers.ts embeds its source), connect's call it
 * straight from a fetch spy. So every helper stays inside it.
 */
/* oxlint-disable unicorn/consistent-function-scoping */
export const npmRegistryFake = () => {
  const origin = "https://registry.npmjs.org";
  const day = 24 * 60 * 60 * 1000;

  /** One entry of a hand-made tarball. */
  interface Entry {
    path: string;
    /** ustar type flag: "0" file, "1" hard link, "2" symlink, "5" directory, "x" PAX header, … */
    type?: string;
    content?: string;
    /** For a link: what it points at. */
    linkname?: string;
    /** A file of this many zero bytes, streamed (an archive bomb's). */
    zeros?: number;
    /** PAX records, for a "x" entry. */
    pax?: Record<string, string>;
  }

  /** A version a test publishes. */
  interface Published {
    name: string;
    version: string;
    /** package.json's other fields: dependencies, peers, scripts, exports… */
    manifest?: Record<string, unknown>;
    /** Files under `package/`, besides package.json. */
    files?: Record<string, string>;
    /** Entries as they are, instead of `files` and package.json. */
    entries?: Entry[];
    /** When it was published; 30 days ago unless said. */
    publishedAt?: string;
    /** The metadata names this integrity instead of the tarball's own. */
    integrity?: string;
    /** The metadata says no more than a SHA-1 (`shasum`), as very old versions do. */
    sha1Only?: boolean;
  }

  interface Stored {
    published: Published;
    tarball: Uint8Array;
    integrity: string;
    shasum: string;
  }

  const packages = new Map<string, Map<string, Stored>>();
  const overrides = new Map<string, () => Response>();
  const asked: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }[] = [];

  const encoder = new TextEncoder();

  const octal = (value: number, length: number): string =>
    `${value.toString(8).padStart(length - 1, "0")}\0`;

  /** One 512-byte ustar header. */
  const header = (
    path: string,
    size: number,
    type: string,
    linkname = ""
  ): Uint8Array => {
    const block = new Uint8Array(512);
    const put = (text: string, at: number, length: number): void => {
      block.set(encoder.encode(text).subarray(0, length), at);
    };
    // Long paths go in the prefix field, as ustar allows.
    let name = path;
    let prefix = "";
    if (encoder.encode(path).length > 100) {
      const cut = path.lastIndexOf("/", 155);
      prefix = path.slice(0, cut);
      name = path.slice(cut + 1);
    }
    put(name, 0, 100);
    put(octal(0o644, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(size, 12), 124, 12);
    put(octal(0, 12), 136, 12);
    put("        ", 148, 8);
    put(type, 156, 1);
    put(linkname, 157, 100);
    put("ustar\u000000", 257, 8);
    put(prefix, 345, 155);
    let sum = 0;
    for (const byte of block) {
      sum += byte;
    }
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    return block;
  };

  const padding = (size: number): Uint8Array =>
    new Uint8Array((512 - (size % 512)) % 512);

  /** PAX records as a "x" entry's content: `<length> <key>=<value>\n`. */
  const paxContent = (records: Record<string, string>): string =>
    Object.entries(records)
      .map(([key, value]) => {
        // The length counts the record's UTF-8 bytes, its own digits too.
        const body = ` ${key}=${value}\n`;
        const bodyBytes = encoder.encode(body).byteLength;
        let length = bodyBytes + 1;
        while (String(length).length + bodyBytes !== length) {
          length += 1;
        }
        return `${length}${body}`;
      })
      .join("");

  /** The tarball's bytes, as a stream: zeros are made as they are read. */
  const tarStream = (entries: Entry[]): ReadableStream<Uint8Array> => {
    const chunk = 64 * 1024;
    // Bytes as they are, or a count of zeros made only as they are read.
    const parts: (Uint8Array | number)[] = [];
    for (const entry of entries) {
      const type = entry.type ?? "0";
      if (entry.zeros === undefined) {
        const content = encoder.encode(
          entry.pax === undefined
            ? (entry.content ?? "")
            : paxContent(entry.pax)
        );
        parts.push(
          header(entry.path, content.length, type, entry.linkname),
          content,
          padding(content.length)
        );
      } else {
        parts.push(
          header(entry.path, entry.zeros, type),
          entry.zeros,
          padding(entry.zeros)
        );
      }
    }
    parts.push(new Uint8Array(1024));
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        const next = parts.shift();
        if (next === undefined) {
          controller.close();
        } else if (typeof next === "number") {
          controller.enqueue(new Uint8Array(Math.min(chunk, next)));
          if (next > chunk) {
            parts.unshift(next - chunk);
          }
        } else {
          controller.enqueue(next);
        }
      },
    });
  };

  const collect = async (
    stream: ReadableStream<Uint8Array>
  ): Promise<Uint8Array> => {
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    return bytes;
  };

  const base64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCodePoint(byte);
    }
    return btoa(binary);
  };

  const hex = (bytes: Uint8Array): string =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  /** A package's tarball as npm packs one: package.json and its files under `package/`. */
  const entriesOf = (published: Published): Entry[] =>
    published.entries ?? [
      {
        path: "package/package.json",
        content: JSON.stringify({
          name: published.name,
          version: published.version,
          ...published.manifest,
        }),
      },
      ...Object.entries(published.files ?? {}).map(([path, content]) => ({
        path: `package/${path}`,
        content,
      })),
    ];

  const publish = async (published: Published): Promise<void> => {
    const tarball = await collect(
      tarStream(entriesOf(published)).pipeThrough(new CompressionStream("gzip"))
    );
    const integrity = `sha512-${base64(
      new Uint8Array(await crypto.subtle.digest("SHA-512", tarball))
    )}`;
    const shasum = hex(
      new Uint8Array(await crypto.subtle.digest("SHA-1", tarball))
    );
    const versions = packages.get(published.name) ?? new Map<string, Stored>();
    versions.set(published.version, { published, tarball, integrity, shasum });
    packages.set(published.name, versions);
  };

  /** The integrity the registry names for a version it has. */
  const integrityOf = (name: string, version: string): string | undefined => {
    const stored = packages.get(name)?.get(version);
    return stored === undefined
      ? undefined
      : (stored.published.integrity ?? stored.integrity);
  };

  const tarballPath = (name: string, version: string): string =>
    `/${name}/-/${name.slice(name.indexOf("/") + 1)}-${version}.tgz`;

  const notFound = (): Response =>
    Response.json({ error: "Not found" }, { status: 404 });

  /** The fields npm's abbreviated metadata keeps of a version. */
  const abbreviatedFields = new Set([
    "name",
    "version",
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bundleDependencies",
    "bin",
    "engines",
    "os",
    "cpu",
    "deprecated",
    "hasInstallScript",
    "dist",
  ]);

  /**
   * A package's metadata: the full packument, or, when asked for npm's
   * abbreviated install metadata (`application/vnd.npm.install-v1+json`),
   * that one, which has no `time`, licence or scripts.
   */
  const packument = (
    name: string,
    versions: Map<string, Stored>,
    abbreviated: boolean
  ): Response => {
    const time: Record<string, string> = {};
    const listed: Record<string, Record<string, unknown>> = {};
    let latest = "";
    for (const [version, stored] of versions) {
      const publishedAt =
        stored.published.publishedAt ??
        new Date(Date.now() - 30 * day).toISOString();
      time[version] = publishedAt;
      latest = version;
      listed[version] = {
        name,
        version,
        ...stored.published.manifest,
        readme: "Use this package as instructed.",
        _id: `${name}@${version}`,
        dist: {
          shasum: stored.shasum,
          tarball: `${origin}${tarballPath(name, version)}`,
          ...(stored.published.sha1Only === true
            ? {}
            : { integrity: stored.published.integrity ?? stored.integrity }),
        },
      };
    }
    if (abbreviated) {
      const kept: Record<string, unknown> = {};
      for (const [version, manifest] of Object.entries(listed)) {
        kept[version] = Object.fromEntries(
          Object.entries(manifest).filter(([field]) =>
            abbreviatedFields.has(field)
          )
        );
      }
      return Response.json(
        {
          name,
          modified: Object.values(time).at(-1),
          "dist-tags": { latest },
          versions: kept,
        },
        { headers: { "content-type": "application/vnd.npm.install-v1+json" } }
      );
    }
    return Response.json({
      _id: name,
      name,
      "dist-tags": { latest },
      versions: listed,
      time: {
        created: Object.values(time)[0],
        modified: Object.values(time).at(-1),
        ...time,
      },
    });
  };

  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    asked.push({
      method: request.method,
      path: url.pathname,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    });
    const override = overrides.get(url.pathname);
    if (override !== undefined) {
      return override();
    }
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    const tarball =
      /^\/(?<name>(?:@[^/]+\/)?[^/]+)\/-\/(?<file>[^/]+)\.tgz$/u.exec(
        url.pathname
      )?.groups;
    if (tarball !== undefined) {
      const { name = "", file = "" } = tarball;
      const base = name.slice(name.indexOf("/") + 1);
      const version = file.startsWith(`${base}-`)
        ? file.slice(base.length + 1)
        : "";
      const stored = packages.get(name)?.get(version);
      return stored === undefined
        ? notFound()
        : new Response(stored.tarball, {
            headers: { "content-type": "application/octet-stream" },
          });
    }
    const name = decodeURIComponent(url.pathname.slice(1));
    const versions = packages.get(name);
    const abbreviated = (request.headers.get("accept") ?? "").includes(
      "application/vnd.npm.install-v1+json"
    );
    return versions === undefined
      ? notFound()
      : packument(name, versions, abbreviated);
  };

  return {
    origin,
    asked,
    publish,
    integrityOf,
    tarballPath,
    /** Answers `path` with what `respond` makes, instead of the registry's own. */
    override: (path: string, respond: () => Response): void => {
      overrides.set(path, respond);
    },
    answer,
    /** Forgets everything published, overridden and asked. */
    reset: (): void => {
      packages.clear();
      overrides.clear();
      asked.length = 0;
    },
  };
};

export type NpmRegistryFake = ReturnType<typeof npmRegistryFake>;
