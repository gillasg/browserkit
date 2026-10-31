// site-to-api: parse any site into a typed API.
export * from "./types.js";
export {
  buildSiteModel,
  STAGES,
  type BuildOptions,
  type BuildResult,
  type Stage,
} from "./pipeline.js";
export {
  loadCapture,
  parseCapture,
  mergeCaptures,
  fromHar,
  fromMitmproxy,
  encodeTnetstring,
} from "./load/index.js";
export { filterExchanges, learnNoise, type FilterOptions } from "./filter.js";
export { inputParams, documentedParams, isDerived } from "./params.js";
export { inferSchema } from "./infer/schema.js";
export { templatePaths } from "./infer/templates.js";
export { detectCapabilities, capabilityIndex } from "./infer/capabilities.js";
export {
  siteCapabilities,
  withWebMcp,
  type SiteCapabilities,
  type SiteAbilitySummary,
  type SiteOperationSummary,
} from "./site-capabilities.js";
export {
  abilityDirectory,
  abilitySlug,
  createAbility,
  listAbilities,
  maintainAbilities,
  readAbility,
  readSiteNotes,
  runAbility,
  saveAbility,
  testAbility,
  trashAbility,
  writeSiteNotes,
  type AbilityRunOptions,
  type SaveAbilityOptions,
  type Ability,
  type AbilityCreatedBy,
  type AbilityHost,
  type AbilityKind,
  type AbilityOptions,
  type AbilityRunResult,
  type AbilityStats,
  type AbilityVia,
  type AbilityWay,
  type AbilityWayApi,
  type AbilityWayPage,
  type AbilityWayScript,
  type AbilityWaySteps,
} from "./abilities.js";
export {
  buildAbility,
  type BlockedReason,
  type BuildOptions as AbilityBuildOptions,
  type BuildResult as AbilityBuildResult,
} from "./build.js";
export { pageRows, type AbilityCheck, type AbilityPage } from "./ability-records.js";
export {
  AbilityWriteError,
  type OutcomeCode,
  type ReadBack,
  type RetryClass,
  type WriteOutcome,
  type WriteStatus,
} from "./ability-writes.js";
export type { AbilityTest, AbilityTestReport } from "./ability-contract.js";
export { abilityNeeds, wayNeeds, missingNeeds, type AbilityNeed } from "./ability-needs.js";
export {
  abilityFromAction,
  abilityFromRecipe,
  abilityFromSkill,
  abilityFromTool,
  abilityFromWorkflow,
  importPackAbilities,
  migrateAllAbilities,
  migrateSiteAbilities,
  type MigrationOptions,
  type MigrationReport,
  type MigrationSkill,
  type SiteMigrationReport,
  type Unmigrated,
} from "./abilities-migrate.js";
export { volatileFields, type VolatileField, type VolatileReason } from "./infer/volatile.js";
export { extractEmbedded } from "./infer/html.js";
export { toOpenApi, toAsyncApi } from "./emit/openapi.js";
export { toYaml } from "./emit/yaml.js";
export { generateClient } from "./emit/client.js";
export { markdownReport, curlExample, redactedSamples } from "./emit/report.js";
export { htmlReport } from "./emit/html.js";
export { createRedactor } from "./redact.js";
export {
  exportSitePack,
  installSitePack,
  readSitePack,
  skillsForSite,
  PACK_FORMAT,
  PACK_VERSION,
  type PackBoost,
  type PackExport,
  type PackManifest,
  type PackSkill,
  type SitePack,
} from "./pack.js";
export { diffModels, formatDiff, schemaChanges } from "./diff.js";
export * from "./registry.js";
export { rebuild, importCaptures, saveRecording, loadFlows } from "./workflow.js";
export { RecordingSession, PassiveRecorder, type Recording, type RecordOptions } from "./record.js";
export { checkHealth, repair, readHealth, type HealthReport, type HealthResult } from "./health.js";
export { detectChallenge, type Challenge } from "./challenge.js";
export { coverage, type Suggestion } from "./coverage.js";
export { serve, type Server, type ServeOptions } from "./serve.js";
export { runMcpServer } from "./mcp.js";
export { performFlow, editApi, nameOperations, type ModelLike } from "./agent.js";
export { explore, EXPLORE_BRIEF, type ExploreOptions, type ExploreResult } from "./explore.js";
export { watch, type WatchOptions, type WatchResult } from "./watch.js";
export * from "./recipes.js";
export {
  isSiteToolRequest,
  listSiteTools,
  readPageTool,
  readSiteTools,
  runSiteTool,
  setSiteToolsEnabled,
  siteToolSummaryFor,
  writeSiteTools,
  type SiteTool,
  type SiteToolFile,
  type SiteToolParam,
  type SiteToolParamType,
  type SiteToolSummary,
} from "./site-tools.js";
export { readLearned, learnAbout, learnedHint, type LearnedNote } from "./learned.js";
export {
  runRecipe,
  readFeed,
  RecipeError,
  RecipeSkip,
  resolveParams,
  resolveOperationInModel,
  type FeedResult,
  type RecipeHost,
  type RecipeRunOptions,
  type RecipeRunResult,
  type StrategyAttempt,
} from "./runtime/recipe.js";
export { browserRecipeHost, runSiteRecipe, type RecipeHostOptions } from "./runtime/recipe-host.js";
export { collectExpression, type CollectInput } from "./runtime/collect.js";
export { readDocs } from "./docs.js";
export { code, type SiteCodeOptions, type SiteCodeResult, type SiteCodeMatch } from "./code.js";
export {
  checkCaptures,
  exportSite,
  isSiteToolAction,
  runSiteToolAction,
  signingInfo,
  SITE_TOOL_ACTIONS,
  SITE_TOOL_HELP,
  type SiteToolAction,
  type SiteToolInput,
} from "./tool.js";
export {
  isSiteMapperRequest,
  handleSiteMapperRequest,
  type SiteMapperRequest,
} from "./requests.js";
export {
  learnLive,
  writeLive,
  undoLive,
  reversePairs,
  writeKind,
  requestShape,
  NotProven,
  type LearnedOperation,
  type LiveLearnResult,
  type WriteKind,
} from "./live.js";
export * from "./runtime/index.js";
