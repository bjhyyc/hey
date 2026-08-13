/**
 * Global state management for panel
 */

import { TRIGGER_PARAMETER_FIELDS } from "./panel-state.js";

export const state = {
  activeTab: "overview",
  config: null,
  savingKey: "",
  selectedStateType: "idle",
  selectedStateEntryId: "",
  selectedActionId: "",
  selectedRuleId: "",
  selectedRuleExportIds: [],
  ruleEditorOpen: false,
  animationEditorOpen: false,
  keyframeEditorOpen: false,
  keyframeEditorClipId: "",
  keyframeEditorIsDraft: false,
  keyframeEditorKeyframes: [],
  keyframeEditorSelectedIndex: null,
  keyframeEditorAssetUrl: "",
  keyframeEditorAssetPath: "",
  keyframeEditorGreenScreen: null,
  selectedConditionType: Object.keys(TRIGGER_PARAMETER_FIELDS)[0],
  selectedAssetPath: "",
  selectedAssetPackageId: "",
  selectedAssetBindingTarget: "custom",
  selectedAssetActionId: "",
  selectedAssetResult: null,
  assetProgress: null,
  packageList: [],
  packageAssets: [],
  selectedPackageAsset: "",
  animationDraft: null,
  isCreatingPackage: false,
  packageEditMode: false,
  assetEditMode: false,
  petpackResult: null,
  onboardingJustCompleted: false,
  systemLaunchAtLogin: false,
  aboutInfo: null,
  updateCheck: { status: "idle" },
  logSettings: null,
  logFiles: [],
  selectedLogFile: "",
  logContent: "",
  logTruncated: false,
  logLoading: false
};

/**
 * Update state and optionally trigger render
 * @param {object} updates - State updates
 * @param {Function} [renderCallback] - Optional render callback
 */
export function updateState(updates, renderCallback) {
  Object.assign(state, updates);
  if (renderCallback) {
    renderCallback();
  }
}
