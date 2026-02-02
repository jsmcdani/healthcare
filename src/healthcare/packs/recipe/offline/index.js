/**
 * Offline Recipe Module Index
 *
 * Exports offline recipe infrastructure and recipe definitions.
 */

export {
  OfflineRecipeRunner,
  OfflineRecipeTypes,
  OFFLINE_NAMESPACE,
  getOfflineRecipeRunner
} from './OfflineRecipeRunner.js';

// Recipe paths for loading
export const OfflineRecipes = {
  DETERMINANTS_BUILD: './determinants-build.recipe.json',
  HOTSPOTS_COMPUTE: './hotspots-compute.recipe.json',
  AFFINITY_ANALYZE: './affinity-analyze.recipe.json'
};

/**
 * Load all offline recipes into a config loader
 */
export async function loadOfflineRecipes(configLoader) {
  const recipes = [];

  // Load each recipe JSON
  const recipeFiles = [
    { id: 'offline.determinants.build.v1', path: './determinants-build.recipe.json' },
    { id: 'offline.hotspots.compute.v1', path: './hotspots-compute.recipe.json' },
    { id: 'offline.affinity.analyze.v1', path: './affinity-analyze.recipe.json' }
  ];

  for (const { id, path } of recipeFiles) {
    try {
      // Dynamic import for JSON
      const module = await import(path, { assert: { type: 'json' } });
      const recipe = module.default;

      if (configLoader && configLoader.registerRecipe) {
        configLoader.registerRecipe(recipe);
      }

      recipes.push(recipe);
    } catch (e) {
      console.warn(`[OfflineRecipes] Failed to load ${id}:`, e.message);
    }
  }

  return recipes;
}
