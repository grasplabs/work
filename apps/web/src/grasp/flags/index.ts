// The flags of Damsko: one entry point for the whole system. Every flag is a drawing from
// country-flag-icons (MIT, 3 by 2), named by its region's code (ISO 3166-1), so a product ships only
// the flags it imports. Add a region here before using it.
//
//   import { Flag, NL } from "../../flags";
//   <Flag flag={NL} />                    beside words that name it
//   <Flag flag={NL} label="Netherlands" />  standing alone, with a name
//   <Flag code="AR" />                    a language with no fair flag: its code, in the same shape
//
// A flag stands for a region, not a language: a product that lists a language without a region
// says which flag stands for it.
export { Flag, type FlagData, type FlagProps, type FlagSize } from "./flag";

export {
  AT,
  AU,
  BE,
  BG,
  BR,
  CA,
  CH,
  CN,
  CZ,
  DE,
  DK,
  ES,
  EU,
  FI,
  FR,
  GB,
  GR,
  HU,
  ID,
  IE,
  IL,
  IN,
  IT,
  JP,
  KR,
  MX,
  MY,
  NL,
  NO,
  PL,
  PT,
  RO,
  SE,
  TH,
  TR,
  TW,
  UA,
  US,
  VN,
} from "country-flag-icons/string/3x2";
