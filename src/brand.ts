import chalk from "chalk";

/**
 * Elena's look in the terminal: solid terminal green and beige.
 * Green is the terminal's own green (ANSI), so it matches whatever theme you use.
 */
export const green = chalk.green;
export const beige = chalk.hex("#E8DCC4");

/** The icon's "e:" in half-block characters, 4 rows by 9 columns. */
const ART = [
  " ▄▀▀▀▄   ",
  " █▄▄▄█ ▀ ",
  " █       ",
  "  ▀▀▀▀ ▀ ",
];

/** Banner: the e: on the left, up to three lines of text beside rows 2-4. */
export function banner(lines: string[]): string {
  return ART.map((art, i) => {
    const text = i === 0 ? "" : (lines[i - 1] ?? "");
    return `${green.bold(art)}${text ? " " + text : ""}`.trimEnd();
  }).join("\n");
}

export const tagline = `${green.bold("elena")} ${beige("· local developer assistant")}`;
