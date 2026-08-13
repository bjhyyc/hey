const DEFAULT_CONFIG = {
  currentPackageId: "default-pet",
  display: {
    x: 80,
    y: 160,
    scale: 1,
    opacity: 1,
    alwaysOnTop: true,
    mousePassthrough: false,
    locked: false
  },
  system: {
    launchAtLogin: false,
    language: "en",
    onboardingVersion: 0,
    logging: {
      enabled: true,
      level: "info"
    }
  },
  animations: {
    default: { id: "00000000-0000-4000-8000-000000000001", name: "默认动画", asset: "assets/idle.svg" },
    clips: [
      { id: "00000000-0000-4000-8000-000000000002", name: "点击动画", asset: "assets/click.svg", type: "oneshot", durationMs: 900 },
      { id: "00000000-0000-4000-8000-000000000003", name: "拖拽动画", asset: "assets/drag.svg", type: "loop" }
    ]
  },
  interactions: {
    clickMessages: ["Hi there!"],
    randomMessages: ["I'm here."],
    timedMessages: [],
    importSuccessMessage: "Petpack imported.",
    bubble: {
      maxWidth: 220,
      durationMs: 1800,
      showCloseButton: false
    }
  },
  triggerRules: []
};

const DEFAULT_RULE_TEMPLATES = [
  {
    id: "default-click-greeting",
    name: "点击打招呼",
    enabled: true,
    conditions: [{ type: "click", required: true, filters: [] }],
    cooldownMs: 1000,
    priority: 50,
    actionStrategy: "sequence",
    actions: [
      { type: "playAnimation", animation: "00000000-0000-4000-8000-000000000002" },
      { type: "randomMessage", messages: ["Hi there!"], durationMs: 1800 }
    ]
  },
  {
    id: "default-right-click-panel",
    name: "右键打开面板",
    enabled: true,
    conditions: [{ type: "rightClick", required: true, filters: [] }],
    cooldownMs: 500,
    priority: 100,
    actionStrategy: "sequence",
    actions: [{ type: "openPanel" }]
  },
  {
    id: "default-dragging",
    name: "拖动中",
    enabled: true,
    conditions: [{ type: "dragStart", required: false }, { type: "dragging", required: false }],
    cooldownMs: 0,
    priority: 90,
    actionStrategy: "sequence",
    actions: [{ type: "playAnimation", animation: "00000000-0000-4000-8000-000000000003" }]
  },
  {
    id: "default-hover",
    name: "悬停互动",
    enabled: true,
    conditions: [{ type: "mouseEnter", required: true }],
    cooldownMs: 1000,
    priority: 30,
    actionStrategy: "sequence",
    actions: [{ type: "playAnimation", animation: "00000000-0000-4000-8000-000000000002" }]
  },
  {
    id: "default-random-timer",
    name: "随机互动",
    enabled: true,
    conditions: [{ type: "randomTimer", required: true }],
    cooldownMs: 5000,
    priority: 10,
    actionStrategy: "sequence",
    actions: [{ type: "playAnimation", animation: "00000000-0000-4000-8000-000000000002" }]
  },
  {
    id: "default-timed",
    name: "定时互动",
    enabled: true,
    conditions: [{ type: "timer", required: true }],
    cooldownMs: 5000,
    priority: 10,
    actionStrategy: "sequence",
    actions: [{ type: "showMessage", text: "I'm here.", durationMs: 1800 }]
  },
  {
    id: "default-idle-sleep",
    name: "休息状态",
    enabled: true,
    conditions: [{ type: "idleDuration", required: true, filters: [{ field: "elapsedMs", operator: ">=", value: 60000, unit: "ms" }] }],
    cooldownMs: 10000,
    priority: 5,
    actionStrategy: "sequence",
    actions: [{ type: "showMessage", text: "Zzz...", durationMs: 1800 }]
  }
];

DEFAULT_CONFIG.triggerRules = DEFAULT_RULE_TEMPLATES;

module.exports = { DEFAULT_CONFIG, DEFAULT_RULE_TEMPLATES };
