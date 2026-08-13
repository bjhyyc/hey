// 调试日志开关由系统设置里的日志开关和日志等级共同驱动。
// pet 渲染进程在加载/更新配置时调用 setDebugRulesEnabled() 同步该状态。
let rulesEnabled = false;
let rulesLevel = "info";

function setDebugRulesEnabled(enabled, level = rulesLevel) {
  rulesEnabled = Boolean(enabled);
  rulesLevel = String(level || "info").toLowerCase();
}

function debugRulesEnabled() {
  return rulesEnabled && (rulesLevel === "debug" || rulesLevel === "trace");
}

function formatDebugArg(arg) {
  if (arg && typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch (_error) {
      return String(arg);
    }
  }
  return arg;
}

function defaultNow() {
  return Date.now();
}

function createDebugLogger(prefix, options = {}) {
  const throttleMsByMessage = options.throttleMsByMessage || {};
  const now = typeof options.now === "function" ? options.now : defaultNow;
  const lastLoggedAtByMessage = new Map();

  return function debugLog(...args) {
    if (!debugRulesEnabled()) return;

    const message = String(args[0] || "");
    const throttleMs = Number(throttleMsByMessage[message] || 0);
    if (Number.isFinite(throttleMs) && throttleMs > 0) {
      const current = now();
      const lastLoggedAt = lastLoggedAtByMessage.get(message);
      if (lastLoggedAt !== undefined && current - lastLoggedAt < throttleMs) {
        return;
      }
      lastLoggedAtByMessage.set(message, current);
    }

    const api = globalThis.desktopPet;
    if (api && api.logs && typeof api.logs.write === "function") {
      api.logs.write("debug", "pet-rules", prefix, args.map(formatDebugArg));
    }
  };
}

export { debugRulesEnabled, setDebugRulesEnabled, createDebugLogger };
