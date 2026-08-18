"use strict";

const IMAGE_METHODS = Object.freeze([
  "createFrontMaster",
  "createSideMaster",
  "createSleepingMaster"
]);
const VIDEO_METHODS = Object.freeze([
  "createVideoTask",
  "getVideoTask"
]);

function boundedConcurrency(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32) {
    throw new Error(`${label} must be between 1 and 32`);
  }
  return parsed;
}

class FifoAdmissionGate {
  constructor({ limit, operationClass, logger = console } = {}) {
    this.limit = boundedConcurrency(limit, `${operationClass} ModelArk concurrency`);
    this.operationClass = operationClass;
    this.logger = logger;
    this.active = 0;
    this.waiters = [];
  }

  async run(operation) {
    if (typeof operation !== "function") throw new Error("ModelArk admission operation is required");
    if (this.active >= this.limit) {
      this.logger.info?.("petpack.modelark.admission_wait", {
        operationClass: this.operationClass,
        active: this.active,
        waiting: this.waiters.length + 1,
        limit: this.limit
      });
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }

  snapshot() {
    return Object.freeze({
      operationClass: this.operationClass,
      active: this.active,
      waiting: this.waiters.length,
      limit: this.limit
    });
  }
}

function createConcurrencyLimitedModelArkClient(client, {
  imageMaxConcurrent = 1,
  videoMaxConcurrent = 1,
  logger = console
} = {}) {
  if (!client || typeof client !== "object") throw new Error("ModelArk client is required");
  const imageGate = new FifoAdmissionGate({
    limit: imageMaxConcurrent,
    operationClass: "image",
    logger
  });
  const videoGate = new FifoAdmissionGate({
    limit: videoMaxConcurrent,
    operationClass: "video",
    logger
  });
  const wrapped = new Map();
  for (const [methods, gate] of [[IMAGE_METHODS, imageGate], [VIDEO_METHODS, videoGate]]) {
    for (const method of methods) {
      if (typeof client[method] !== "function") continue;
      wrapped.set(method, (...args) => gate.run(() => client[method](...args)));
    }
  }
  const admissionSnapshot = () => Object.freeze({
    image: imageGate.snapshot(),
    video: videoGate.snapshot()
  });
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "admissionSnapshot") return admissionSnapshot;
      if (wrapped.has(property)) return wrapped.get(property);
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set() {
      throw new Error("Concurrency-limited ModelArk client is immutable");
    }
  });
}

module.exports = {
  FifoAdmissionGate,
  IMAGE_METHODS,
  VIDEO_METHODS,
  createConcurrencyLimitedModelArkClient
};
