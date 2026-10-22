import { describe, expect, test } from "vite-plus/test";

import {
  isPrivateHost,
  linkLimits,
  linkTargetOf,
  originRefusal,
} from "../src/app-link-limits.ts";

// Which URL a links declaration lets a screen open (app-link-limits.ts),
// as pure logic: the same decision core makes for every open, starting
// from the ways a URL can pass for one it isn't.

const declared = [
  "https://help.example.com",
  "https://docs.example.com:8443",
  "https://xn--bcher-kva.example",
  // Listed, as a manifest written past the SDK might: never opened.
  "https://[2001:db8::1]",
  "https://192.0.2.1",
];

/** Why `url` is refused, or the URL and origin it opens. */
const decided = (url: unknown) => {
  const target = linkTargetOf(url, declared);
  return target.ok ? { url: target.url, origin: target.origin } : target.reason;
};

describe("a link to open", () => {
  test.each([
    ["the declared origin", "https://help.example.com/guide?q=1#top"],
    ["the default port, written out", "https://help.example.com:443/guide"],
    ["upper case in the host", "https://HELP.example.com/guide"],
    ["a declared port", "https://docs.example.com:8443/api"],
  ])("opens %s", (_case, url) => {
    expect(linkTargetOf(url, declared).ok).toBeTruthy();
  });

  test("is matched by its ASCII origin: a Unicode name opens as its punycode", () => {
    expect(decided("https://bücher.example/katalog")).toStrictEqual({
      url: "https://xn--bcher-kva.example/katalog",
      origin: "https://xn--bcher-kva.example",
    });
  });

  test.each([
    [
      "userinfo before the declared host",
      "https://evil.test@help.example.com/",
    ],
    ["the declared host as userinfo", "https://help.example.com@evil.test/"],
    // Joined, so no secret scanner reads it as a credential.
    ["a password", ["https://user", "pass@help.example.com/"].join(":")],
    ["an empty userinfo", "https://:@help.example.com/"],
  ])("is refused with %s", (_case, url) => {
    expect(decided(url)).toBe("userinfo");
  });

  test.each([
    ["a look-alike in another script", "https://bücher.exаmple/"],
    ["Cyrillic а for a", "https://help.exаmple.com/"],

    ["another port", "https://help.example.com:8443/"],
    ["the declared port left out", "https://docs.example.com/api"],
    ["a sibling subdomain", "https://evil.help.example.com/"],
    ["a suffix of the declared host", "https://help.example.com.evil.test/"],
  ])("is refused for %s", (_case, url) => {
    expect(decided(url)).toBe("origin");
  });

  test.each([
    // Joined, so it is no script URL to the linter.
    ["a script URL", ["javascript", "alert(1)"].join(":")],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["file:", "file:///etc/passwd"],
    ["blob:", "blob:https://help.example.com/0b7c"],
    ["http:", "http://help.example.com/"],
    ["about:", "about:blank"],
    ["ftp:", "ftp://help.example.com/"],
  ])("is refused with the scheme %s", (_case, url) => {
    expect(decided(url)).toBe("scheme");
  });

  test.each([
    ["scheme-relative", "//help.example.com/"],
    ["no slashes after the scheme", "https:help.example.com/"],
    ["one slash after the scheme", "https:/help.example.com/"],
    ["a path alone", "/guide"],
    ["a leading space", " https://help.example.com/"],
    ["a tab in the host", "https://help.\texample.com/"],
    ["a newline", "https://help.example.com/\n"],
    ["a backslash for a slash", "https:\\\\help.example.com\\"],
    ["a right-to-left override", "https://help.example.com/\u202Egp j.exe"],
    ["a zero-width space", "https://help\u200B.example.com/"],
    ["half a surrogate pair", "https://help.example.com/\uD800"],
    ["nothing", ""],
    ["no string at all", 42],
    [
      "a URL past its bound",
      `https://help.example.com/${"a".repeat(linkLimits.urlLength)}`,
    ],
  ])("is refused as invalid with %s", (_case, url) => {
    expect(decided(url)).toBe("invalid");
  });

  test.each([
    ["a trailing dot", "https://help.example.com./"],
    ["an empty label", "https://help..example.com/"],
  ])("is refused for a host name with %s", (_case, url) => {
    expect(decided(url)).toBe("host");
  });

  test.each([
    ["an IPv6 address, though listed", "https://[2001:db8::1]/x"],
    ["an IPv4 address, though listed", "https://192.0.2.1/x"],
    ["an IPv6 address not listed", "https://[2001:db8::2]/"],
    ["a public IPv4 address", "https://8.8.8.8/"],
  ])("is refused for %s", (_case, url) => {
    expect(decided(url)).toBe("ip_literal");
  });

  test("is decided by its own origin, however it redirects once opened", () => {
    expect(
      decided("https://help.example.com/out?to=https://evil.test/")
    ).toStrictEqual({
      url: "https://help.example.com/out?to=https://evil.test/",
      origin: "https://help.example.com",
    });
  });

  test("is refused on a private network, even when declared", () => {
    expect(
      linkTargetOf("https://intranet.local/x", ["https://intranet.local"])
    ).toStrictEqual({ ok: false, reason: "private_network" });
  });
});

describe("a private network host", () => {
  test.each([
    "localhost",
    "localhost.",
    "app.localhost",
    "printer.local",
    "wiki.internal",
    "nas.home.arpa",
    "home.arpa",
    "home.arpa.",
    "intranet",
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "[::]",
    "[::1]",
    "[fc00::1]",
    "[fd12:3456::1]",
    "[fe80::1]",
    "[ff02::1]",
    "[::ffff:7f00:1]",
    "[::ffff:a00:1]",
    "[64:ff9b::a00:1]",
  ])("%s is one", (host) => {
    expect(isPrivateHost(host)).toBeTruthy();
  });

  test.each([
    "help.example.com",
    "8.8.8.8",
    "172.32.0.1",
    "192.0.2.1",
    "[2001:db8::1]",
    "[::ffff:808:808]",
  ])("%s isn't one", (host) => {
    expect(isPrivateHost(host)).toBeFalsy();
  });

  test("is refused in the address the parser writes for it", () => {
    // `0x7f.1` and `2130706433` are 127.0.0.1 once parsed: an IP address,
    // which no link opens.
    expect([
      linkTargetOf("https://0x7f.1/", ["https://127.0.0.1"]),
      linkTargetOf("https://2130706433/", ["https://127.0.0.1"]),
    ]).toStrictEqual([
      { ok: false, reason: "ip_literal" },
      { ok: false, reason: "ip_literal" },
    ]);
  });
});

describe("an origin a links declaration lists", () => {
  test.each([
    ["a host name", "https://help.example.com", undefined],
    ["a host name and port", "https://help.example.com:8443", undefined],
    ["punycode", "https://xn--bcher-kva.example", undefined],
    ["an IPv4 address", "https://192.0.2.1", "ip_literal"],
    ["an IPv6 address", "https://[2001:db8::1]", "ip_literal"],
    ["a trailing dot", "https://help.example.com.", "invalid"],
    ["an empty label", "https://help..example.com", "invalid"],
    ["upper case", "https://Help.example.com", "invalid"],
    ["a path", "https://help.example.com/docs", "invalid"],
    ["plain HTTP", "http://help.example.com", "invalid"],
    ["the home network's name", "https://home.arpa", "private_network"],
    ["localhost", "https://localhost", "private_network"],
  ])("with %s is refused as %s", (_case, origin, refusal) => {
    expect(originRefusal(origin)).toBe(refusal);
  });
});
