// The stylesheet, checked for the two mistakes it cannot report itself.
//
// CSS fails silently by design: a `var()` naming a variable nobody defined
// makes the declaration invalid at computed-value time, so the property falls
// back to inherit/initial and the page still renders — wrongly. Both of these
// shipped: a panel painted with four invented colour names (`--rs-accent-soft`
// and friends), which fell through to hardcoded LIGHT values and put light text
// on a light ground in dark mode; and a `color: var(--rs-muted)` where the
// palette calls it `--rs-text-muted`.

import { describe, it, expect } from "bun:test";
import { customStyles } from "../src/html/styles";

// `--name: value` — where the palette is declared. Any block will do: what is
// being checked is that the name exists at all.
function declared(css: string): Set<string> {
  return new Set([...css.matchAll(/(--rs-[\w-]+)\s*:/g)].map((m) => m[1]));
}

// `var(--name)` with NO fallback. A `var(--name, #fff)` is deliberate and out
// of scope here — it says what to do when the name is absent.
function usedWithoutFallback(css: string): string[] {
  return [...css.matchAll(/var\(\s*(--rs-[\w-]+)\s*\)/g)].map((m) => m[1]);
}

describe("the stylesheet", () => {
  it("never reads a custom property nobody defines", () => {
    const known = declared(customStyles);
    const missing = [...new Set(usedWithoutFallback(customStyles))].filter((v) => !known.has(v));
    expect(missing).toEqual([]);
  });

  it("gives every palette colour a dark-theme value", () => {
    // The dark palette redefines the light one. A colour defined only in
    // `:root` keeps its light value in dark mode, which is how a background
    // ends up light while the text on it is not.
    const root = customStyles.slice(customStyles.indexOf(":root {"), customStyles.indexOf('[data-theme="dark"]'));
    const dark = customStyles.slice(customStyles.indexOf('[data-theme="dark"] {'));
    const isColour = (v: string): boolean => /^\s*(#|rgb|hsl)/.test(v);
    const lightColours = [...root.matchAll(/(--rs-[\w-]+)\s*:([^;]+);/g)]
      .filter((m) => isColour(m[2]))
      .map((m) => m[1]);
    const darkNames = declared(dark);
    expect(lightColours.filter((v) => !darkNames.has(v))).toEqual([]);
  });
});
