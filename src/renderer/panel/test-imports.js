/**
 * Import validation test
 * This file tests if all imports resolve correctly
 */

// Test all imports from panel.js
import { t, setLocale, initLocale } from "../../shared/i18n.js";
import { state } from "./state.js";
import { initBanner, showBanner, hideBanner } from "./ui/banner.js";
import { renderTabs } from "./ui/tabs.js";
import { renderOverview } from "./tabs/overview.js";
import { renderAssets } from "./tabs/assets.js";
import { renderAnimations } from "./tabs/animations.js";
import { renderInteraction } from "./tabs/interaction.js";
import { renderRules } from "./tabs/rules.js";
import { renderDisplay } from "./tabs/display.js";
import { renderSystem } from "./tabs/system.js";
import { handleFormSubmit } from "./handlers/form-handlers.js";
import { handleTabClick, handleInput, handleChange, handleClickAction } from "./handlers/event-handlers.js";
import { importAssetFromForm } from "./handlers/asset-handlers.js";

console.log("✅ All imports resolved successfully!");
console.log("State:", state);
console.log("Functions available:", {
  t: typeof t,
  renderOverview: typeof renderOverview,
  renderAnimations: typeof renderAnimations,
  handleFormSubmit: typeof handleFormSubmit
});
