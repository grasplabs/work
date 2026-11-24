// Turns the fonts beside this file from the text the shadcn CLI wrote into the files the sheets
// here name. The CLI carries a file's content as text, which a font is not, so each font arrives
// as `<name>.woff2.base64`; this writes `<name>.woff2` from it and removes the text. Run it once
// after every install or update of the fonts item and commit the files it writes; no build runs
// it, so every way of building finds the fonts. The product's checks run it with --check:
//
//   node src/styles/fonts/unpack.mjs           unpacks what is packed; safe to run again
//   node src/styles/fonts/unpack.mjs --check   changes nothing; fails while anything is packed
//
// Either way it fails, with the names, when a file a sheet names is not there, or is not the
// font that was installed: each is held to its checksum (SHA256SUMS, installed beside it).
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const fonts = new URL("./", import.meta.url);
const packed = readdirSync(fonts).filter((name) =>
  name.endsWith(".woff2.base64")
);
const problems = [];

if (process.argv.includes("--check")) {
  for (const name of packed) {
    problems.push(
      `${name} is not unpacked: run node src/styles/fonts/unpack.mjs`
    );
  }
} else {
  for (const name of packed) {
    writeFileSync(
      new URL(name.slice(0, -".base64".length), fonts),
      Buffer.from(readFileSync(new URL(name, fonts), "utf-8"), "base64")
    );
    rmSync(new URL(name, fonts));
  }
}

for (const sheet of readdirSync(fonts).filter((name) => name.endsWith(".css"))) {
  const css = readFileSync(new URL(sheet, fonts), "utf-8");
  for (const [, name] of css.matchAll(/url\("\.\/(?<name>[^"]+)"\)/gu)) {
    if (name !== undefined && !existsSync(new URL(name, fonts))) {
      problems.push(`${name}, which ${sheet} names, is missing`);
    }
  }
}

for (const line of readFileSync(new URL("SHA256SUMS", fonts), "utf-8")
  .split("\n")
  .filter(Boolean)) {
  const [sum, name] = line.split(/\s+/u);
  if (
    existsSync(new URL(name, fonts)) &&
    createHash("sha256")
      .update(readFileSync(new URL(name, fonts)))
      .digest("hex") !== sum
  ) {
    problems.push(`${name} is not the font Damsko ships: install the fonts again`);
  }
}

if (problems.length > 0) {
  console.error(`fonts: ${problems.join("\nfonts: ")}`);
  process.exit(1);
}
