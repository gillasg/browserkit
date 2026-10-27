// Service-worker entry points of the engine. The worker calls installEngineListeners() at load
// to register the engine's Chrome listeners (debugger events, tabs, runtime messages); importing
// a module never touches `chrome` by itself.
export { installEngineListeners } from "./native-engine-install.js";
export { configureEngine, type EngineConfig } from "./engine-config.js";
export { authenticate } from "./native-authenticate.js";
export { handleBrowserCodeMessage, resetRealm } from "./code-runtime-host.js";
export { handleBrowserExecutorMessage, releaseBrowserExecutor } from "./native-browser-executor.js";
export { installBrowserPopupGuard } from "./native-browser-popup.js";
export { installBoosts } from "./native-browser-boosts.js";
export {
  currentInventoryTabs,
  refreshInventoryTab,
  synchronizeBrowserInventory,
} from "./native-inventory-client.js";
export {
  installNativeStartup,
  scheduleExecutorReconnect,
  startExecutorHeartbeat,
} from "./native-executor-lifecycle.js";
export {
  getBrowserIdentity,
  hostErrorCode,
  nativeErrorCode,
  sameScope,
  type BrowserIdentity,
} from "./native-worker-identity.js";
