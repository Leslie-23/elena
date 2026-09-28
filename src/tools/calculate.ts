import { defineTool, str } from "./types.js";

/**
 * Arithmetic for the model, which is unreliable at it. A small recursive-descent parser, not eval:
 * numbers, + - * / % ^, parentheses and a few Math functions. Nothing else can run.
 */
const FUNCS: Record<string, (...a: number[]) => number> = {
  round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
  floor: Math.floor,
  ceil: Math.ceil,
  abs: Math.abs,
  sqrt: Math.sqrt,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
};

export function evaluate(expr: string): number {
  const src = expr.replace(/Math\./g, "").replace(/_/g, "");
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (src[i] === " " || src[i] === "\t") i++;
  };
  const expect = (c: string) => {
    skip();
    if (src[i] !== c) throw new Error(`Expected "${c}" at position ${i + 1}`);
    i++;
  };

  function primary(): number {
    skip();
    if (peek() === "(") {
      i++;
      const v = sum();
      expect(")");
      return v;
    }
    if (peek() === "-") {
      i++;
      return -power();
    }
    if (peek() === "+") {
      i++;
      return power();
    }
    const num = src.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i);
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const name = src.slice(i).match(/^[a-z]+/i)?.[0];
    // hasOwn, so inherited names like "constructor" or "toString" aren't callable.
    if (name && Object.hasOwn(FUNCS, name.toLowerCase())) {
      i += name.length;
      expect("(");
      const args = [sum()];
      skip();
      while (peek() === ",") {
        i++;
        args.push(sum());
        skip();
      }
      expect(")");
      return FUNCS[name.toLowerCase()](...args);
    }
    throw new Error(name ? `Unknown function "${name}"` : `Unexpected "${peek() ?? "end"}" at position ${i + 1}`);
  }
  function power(): number {
    const b = primary();
    skip();
    if (peek() === "^" || src.startsWith("**", i)) {
      i += peek() === "^" ? 1 : 2;
      return b ** power(); // right-associative
    }
    return b;
  }
  function product(): number {
    let v = power();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "*" && op !== "/" && op !== "%") return v;
      if (src.startsWith("**", i)) return v;
      i++;
      const r = power();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
  }
  function sum(): number {
    let v = product();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "+" && op !== "-") return v;
      i++;
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
  }

  const result = sum();
  skip();
  if (i < src.length) throw new Error(`Unexpected "${src[i]}" at position ${i + 1}`);
  return result;
}

export const calculateTool = defineTool(
  "calculate",
  "Evaluate an arithmetic expression exactly, e.g. '(5 + 10*2.5 + 20*0.3) * 1.5' or 'max(6.55, 8)'. " +
    "Supports + - * / % ^, parentheses, round(x, digits), floor, ceil, abs, sqrt, min, max, pow. Use it for any arithmetic.",
  { expression: { type: "string", description: "The expression to evaluate", required: true } },
  async (args) => {
    const expr = str(args, "expression");
    try {
      const v = evaluate(expr);
      if (!Number.isFinite(v)) return `${expr} = ${v} (not a finite number; check for division by zero)`;
      return `${expr} = ${Number(v.toPrecision(12))}`;
    } catch (err) {
      return `Couldn't evaluate "${expr}": ${err instanceof Error ? err.message : String(err)}`;
    }
  },
);
