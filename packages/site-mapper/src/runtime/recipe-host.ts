// A recipe host for a Node process: site calls go through the mapped runtime (page or direct
// transport), and collect/script steps run as browser cells over the shared bridge. The CLI, the
// MCP tools and anything embedding browserkit use this so a recipe behaves the same everywhere.

import { sharedBridge, type Bridge } from "./bridge.js";
import { collectExpression, type CollectInput } from "./collect.js";
import {
  resolveOperationInModel,
  runRecipe,
  type RecipeHost,
  type RecipeRunResult,
} from "./recipe.js";
import { readRecipe, type SiteRecipe } from "../recipes.js";
import { loadModel } from "../registry.js";
import { siteMapper } from "./site-mapper.js";

export interface RecipeHostOptions {
  session?: string;
  transport?: "page" | "direct";
  /** Reuses an already-open bridge (Aeon, tests). */
  bridge?: Bridge;
}

export async function browserRecipeHost(
  site: string,
  options: RecipeHostOptions = {},
): Promise<RecipeHost> {
  const api = await siteMapper(site, options.transport ? { transport: options.transport } : {});
  const model = await loadModel(site);
  let bridge: Bridge | undefined = options.bridge;
  const browser = async (): Promise<Bridge> => {
    bridge ??= await sharedBridge();
    return bridge;
  };
  return {
    call: (operation, params) => api.call(operation, params),
    write: (operation, params) => api.write(operation, params),
    resolveOperation: (wanted) =>
      model === undefined ? undefined : resolveOperationInModel(model, wanted),
    collect: async (input) => {
      const connection = await browser();
      const value = await connection.run(collectExpression(input as CollectInput), {
        session: options.session ?? "site-mapper",
      });
      const rows =
        value && typeof value === "object" ? (value as { rows?: unknown }).rows : undefined;
      return Array.isArray(rows) ? rows : value;
    },
    script: async (code, input) => {
      const connection = await browser();
      return connection.run(
        `(async () => { const fn = (${code}); return await fn(page, bu, ${JSON.stringify(input)}); })()`,
        { session: options.session ?? "site-mapper" },
      );
    },
  };
}

/** Loads a site's recipe and runs it with a browser host. */
export async function runSiteRecipe(
  site: string,
  name: string,
  inputs: Record<string, unknown> = {},
  options: RecipeHostOptions & { limit?: number } = {},
): Promise<RecipeRunResult> {
  const recipe = await readRecipe(site, name);
  if (!recipe) throw new Error(`No recipe ${JSON.stringify(name)} for ${site}`);
  const host = await browserRecipeHost(site, options);
  return runRecipe({
    site,
    recipe,
    inputs,
    host,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}

export type { SiteRecipe };
