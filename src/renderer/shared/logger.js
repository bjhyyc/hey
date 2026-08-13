function serializeData(data) {
  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      stack: data.stack
    };
  }

  if (Array.isArray(data)) {
    return data.map(serializeData);
  }

  if (data && typeof data === "object") {
    try {
      return JSON.parse(JSON.stringify(data));
    } catch (_error) {
      return String(data);
    }
  }

  return data;
}

function write(level, scope, args) {
  const message = args.map((item) => item instanceof Error ? item.message : String(item)).join(" ");
  const data = args.length > 1 ? args.map(serializeData) : serializeData(args[0]);
  const api = globalThis.desktopPetPanel || globalThis.desktopPet;
  if (api && api.logs && typeof api.logs.write === "function") {
    api.logs.write(level, scope, message, data);
  }
}

export function createRendererLogger(scope, options = {}) {
  const mirrorToConsole = options.mirrorToConsole !== false;

  return {
    trace: (...args) => {
      if (mirrorToConsole) console.debug(`[desktop-pet:${scope}]`, ...args);
      write("trace", scope, args);
    },
    debug: (...args) => {
      if (mirrorToConsole) console.debug(`[desktop-pet:${scope}]`, ...args);
      write("debug", scope, args);
    },
    info: (...args) => {
      if (mirrorToConsole) console.info(`[desktop-pet:${scope}]`, ...args);
      write("info", scope, args);
    },
    warn: (...args) => {
      if (mirrorToConsole) console.warn(`[desktop-pet:${scope}]`, ...args);
      write("warn", scope, args);
    },
    error: (...args) => {
      if (mirrorToConsole) console.error(`[desktop-pet:${scope}]`, ...args);
      write("error", scope, args);
    }
  };
}
