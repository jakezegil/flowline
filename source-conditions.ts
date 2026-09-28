/**
 * Workspace development resolution. Each package's `exports` lists a `"flowline-source"` condition
 * pointing at `src/*.ts` ahead of the built `dist/*` files, so tools inside this repo run the
 * sources with no build step, while anything outside it (a `link:` or `file:` dependency, plain
 * Node) gets `dist`. TypeScript picks the condition up from `customConditions` in
 * tsconfig.base.json, `tsx` from `--conditions=flowline-source`, and Vitest from this config,
 * which every `vitest.config.ts` spreads in. The two app `vite.config.ts` files set the same
 * `resolve.conditions` inline (Vite's config loader and the react tsconfig's `rootDir` don't
 * reach this file). A new tsx/Vite entry point needs the condition too, or it runs `dist`.
 */

/** The export condition that selects a workspace package's TypeScript sources. */
export const SOURCE_CONDITION = "flowline-source";

// Vite's defaults (`defaultClientConditions` / `defaultServerConditions`), which setting
// `conditions` would otherwise replace. Copied because the repo root doesn't depend on `vite`.
const CLIENT = ["module", "browser", "development|production"];
const SERVER = ["module", "node", "development|production"];

/** Vite/Vitest resolve options that prefer workspace sources, keeping Vite's default conditions. */
export const sourceConditions = {
  resolve: { conditions: [SOURCE_CONDITION, ...CLIENT] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, ...SERVER] } },
};
