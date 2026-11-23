// Turns the fonts beside this file from the text the shadcn CLI wrote into the files fonts.css
// names. The CLI carries a file's content as text, which a font is not, so each font arrives as
// `<name>.woff2.base64`; this writes `<name>.woff2` from it and removes the text. Run it after
// every install or update of the fonts item, and before every build, so a skipped run cannot
// pass unseen:
//
//   node src/styles/fonts/unpack.mjs           unpacks what is packed; safe to run again
//   node src/styles/fonts/unpack.mjs --check   changes nothing; fails while anything is packed
//
// Either way it fails, with the names, when a file fonts.css names is not there.
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

const sheet = readFileSync(new URL("../fonts.css", import.meta.url), "utf-8");
for (const [, name] of sheet.matchAll(/url\("\.\/fonts\/(?<name>[^"]+)"\)/gu)) {
  if (name !== undefined && !existsSync(new URL(name, fonts))) {
    problems.push(`${name}, which fonts.css names, is missing`);
  }
}

if (problems.length > 0) {
  console.error(`fonts: ${problems.join("\nfonts: ")}`);
  process.exit(1);
}
