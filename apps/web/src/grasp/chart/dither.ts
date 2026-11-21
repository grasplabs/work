// The system's dither lives in src/dither, so a part that only draws its texture (Empty's picture
// of what will stand here) does not bring the charts with it. The charts read it from here as
// they always did.
export * from "../dither/dither";
