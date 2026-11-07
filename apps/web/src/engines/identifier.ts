/** A name as a definition takes it: words joined in camel case, as code names things. */
export const identifierOf = (text: string): string => {
  const words = text
    .normalize("NFKD")
    .replaceAll(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
  const joined = words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join("");
  return /^[0-9]/u.test(joined) ? `_${joined}` : joined;
};
