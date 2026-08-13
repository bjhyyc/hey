const { REQUIRED_ACTION_IDS } = require("../domain/action-catalog");

const POOL_NAMES = Object.freeze(["image", "video", "media", "package", "validation"]);

const DEFAULT_CAPACITY_SCENARIO = Object.freeze({
  orders: 1000,
  arrivalWindowSeconds: 8 * 60 * 60,
  arrivalBurstSize: 20,
  duplicateEvery: 17,
  redeliveryEvery: 29,
  maxDrainSeconds: 60 * 60,
  maxEndToEndSeconds: 2 * 60 * 60,
  maxQueueWaitSeconds: 30 * 60,
  maxUtilization: 0.85,
  pools: Object.freeze({
    image: Object.freeze({ workers: 8, serviceSeconds: 45, maxQueueDepth: 500 }),
    video: Object.freeze({ workers: 72, serviceSeconds: 240, maxQueueDepth: 1500 }),
    media: Object.freeze({ workers: 20, serviceSeconds: 35, maxQueueDepth: 1500 }),
    package: Object.freeze({ workers: 4, serviceSeconds: 20, maxQueueDepth: 500 }),
    validation: Object.freeze({ workers: 6, serviceSeconds: 45, maxQueueDepth: 500 })
  })
});

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${label} must be a bounded positive integer`);
  return value;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

class EventHeap {
  constructor() {
    this.items = [];
    this.sequence = 0;
  }

  push(time, priority, execute) {
    const event = { time, priority, sequence: this.sequence++, execute };
    this.items.push(event);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this._before(this.items[index], this.items[parent])) break;
      [this.items[index], this.items[parent]] = [this.items[parent], this.items[index]];
      index = parent;
    }
  }

  pop() {
    if (!this.items.length) return null;
    const first = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) {
      this.items[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let candidate = index;
        if (left < this.items.length && this._before(this.items[left], this.items[candidate])) candidate = left;
        if (right < this.items.length && this._before(this.items[right], this.items[candidate])) candidate = right;
        if (candidate === index) break;
        [this.items[index], this.items[candidate]] = [this.items[candidate], this.items[index]];
        index = candidate;
      }
    }
    return first;
  }

  _before(left, right) {
    return left.time < right.time ||
      (left.time === right.time && left.priority < right.priority) ||
      (left.time === right.time && left.priority === right.priority && left.sequence < right.sequence);
  }
}

class CapacityPool {
  constructor(name, config, harness) {
    this.name = name;
    this.workers = positiveInteger(config.workers, `${name} workers`, 4096);
    this.serviceSeconds = positiveInteger(config.serviceSeconds, `${name} service seconds`, 24 * 60 * 60);
    this.maxQueueDepthGate = positiveInteger(config.maxQueueDepth, `${name} maximum queue depth`, 10_000_000);
    this.harness = harness;
    this.queue = [];
    this.active = 0;
    this.maxActive = 0;
    this.maxQueueDepth = 0;
    this.completed = 0;
    this.busySeconds = 0;
    this.waitSeconds = [];
  }

  enqueue(task, now) {
    this.queue.push({ ...task, enqueuedAt: now });
    this.drain(now);
    this.maxQueueDepth = Math.max(this.maxQueueDepth, this.queue.length);
  }

  drain(now) {
    while (this.active < this.workers && this.queue.length) {
      const task = this.queue.shift();
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      this.waitSeconds.push(now - task.enqueuedAt);
      this.busySeconds += this.serviceSeconds;
      this.harness.markRunning(task.key);
      this.harness.events.push(now + this.serviceSeconds, 0, () => {
        this.active -= 1;
        this.completed += 1;
        this.harness.markCompleted(task.key);
        task.onComplete(now + this.serviceSeconds);
        this.drain(now + this.serviceSeconds);
      });
    }
  }

  report(simulationSeconds) {
    return {
      workers: this.workers,
      serviceSeconds: this.serviceSeconds,
      completed: this.completed,
      maxActive: this.maxActive,
      maxQueueDepth: this.maxQueueDepth,
      maxQueueDepthGate: this.maxQueueDepthGate,
      maxWaitSeconds: Math.max(0, ...this.waitSeconds),
      p95WaitSeconds: percentile(this.waitSeconds, 0.95),
      utilization: simulationSeconds > 0 ? Number((this.busySeconds / (this.workers * simulationSeconds)).toFixed(4)) : 0
    };
  }
}

function normalizeScenario(input = {}) {
  const pools = {};
  for (const name of POOL_NAMES) {
    pools[name] = { ...DEFAULT_CAPACITY_SCENARIO.pools[name], ...(input.pools?.[name] || {}) };
  }
  return { ...DEFAULT_CAPACITY_SCENARIO, ...input, pools };
}

/**
 * Deterministic, provider-free discrete-event exercise. It models the real
 * dependency graph (awake -> sleep -> seven videos -> seven media jobs ->
 * package -> validator), injects duplicate queued deliveries and completed-job
 * redeliveries, and measures queue backpressure. It is a capacity gate, not a
 * substitute for contracted ModelArk quota or a real PostgreSQL/Redis test.
 */
function simulatePetPackCapacity(input = {}) {
  const config = normalizeScenario(input);
  const orders = positiveInteger(config.orders, "Orders", 1_000_000);
  const arrivalWindowSeconds = positiveInteger(config.arrivalWindowSeconds, "Arrival window", 31 * 24 * 60 * 60);
  const arrivalBurstSize = positiveInteger(config.arrivalBurstSize, "Arrival burst size", orders);
  const duplicateEvery = positiveInteger(config.duplicateEvery, "Duplicate interval", 1_000_000);
  const redeliveryEvery = positiveInteger(config.redeliveryEvery, "Redelivery interval", 1_000_000);
  const maxDrainSeconds = positiveInteger(config.maxDrainSeconds, "Maximum drain time", 31 * 24 * 60 * 60);
  const maxEndToEndSeconds = positiveInteger(config.maxEndToEndSeconds, "Maximum end-to-end time", 31 * 24 * 60 * 60);
  const maxQueueWaitSeconds = positiveInteger(config.maxQueueWaitSeconds, "Maximum queue wait", 31 * 24 * 60 * 60);
  if (typeof config.maxUtilization !== "number" || config.maxUtilization <= 0 || config.maxUtilization > 1) {
    throw new Error("Maximum utilization must be a ratio greater than zero and at most one");
  }
  const events = new EventHeap();
  const tasks = new Map();
  const completions = [];
  const orderState = new Map();
  const duplicateAttempts = { queuedOrRunning: 0, completed: 0 };
  let uniqueSequence = 0;

  const harness = {
    events,
    markRunning(key) { tasks.get(key).state = "running"; },
    markCompleted(key) { tasks.get(key).state = "completed"; }
  };
  const pools = Object.fromEntries(POOL_NAMES.map((name) => [name, new CapacityPool(name, config.pools[name], harness)]));

  function attemptEnqueue(poolName, key, now, onComplete, { injectDuplicates = true } = {}) {
    const existing = tasks.get(key);
    if (existing) {
      if (existing.state === "completed") duplicateAttempts.completed += 1;
      else duplicateAttempts.queuedOrRunning += 1;
      return false;
    }
    const sequence = ++uniqueSequence;
    tasks.set(key, { state: "queued", poolName });
    const complete = (completedAt) => {
      onComplete(completedAt);
      if (sequence % redeliveryEvery === 0) {
        events.push(completedAt + 1, 2, () => {
          attemptEnqueue(poolName, key, completedAt + 1, onComplete, { injectDuplicates: false });
        });
      }
    };
    pools[poolName].enqueue({ key, onComplete: complete }, now);
    if (injectDuplicates && sequence % duplicateEvery === 0) {
      attemptEnqueue(poolName, key, now, onComplete, { injectDuplicates: false });
    }
    return true;
  }

  function startOrder(orderId, arrivedAt) {
    const state = { arrivedAt, mediaCompleted: 0 };
    orderState.set(orderId, state);
    attemptEnqueue("image", `${orderId}:awake`, arrivedAt, (awakeCompletedAt) => {
      attemptEnqueue("image", `${orderId}:sleep`, awakeCompletedAt, (sleepCompletedAt) => {
        for (const actionId of REQUIRED_ACTION_IDS) {
          attemptEnqueue("video", `${orderId}:video:${actionId}`, sleepCompletedAt, (videoCompletedAt) => {
            attemptEnqueue("media", `${orderId}:media:${actionId}`, videoCompletedAt, (mediaCompletedAt) => {
              state.mediaCompleted += 1;
              if (state.mediaCompleted === REQUIRED_ACTION_IDS.length) {
                attemptEnqueue("package", `${orderId}:package`, mediaCompletedAt, (packageCompletedAt) => {
                  attemptEnqueue("validation", `${orderId}:validation`, packageCompletedAt, (completedAt) => {
                    completions.push({ orderId, arrivedAt, completedAt });
                  });
                });
              }
            });
          });
        }
      });
    });
  }

  const arrivalBursts = Math.ceil(orders / arrivalBurstSize);
  for (let index = 0; index < orders; index += 1) {
    const burstIndex = Math.floor(index / arrivalBurstSize);
    const arrivedAt = arrivalBursts === 1 ? 0 : Math.round(burstIndex * arrivalWindowSeconds / (arrivalBursts - 1));
    events.push(arrivedAt, 1, () => startOrder(`order-${index + 1}`, arrivedAt));
  }

  let simulationSeconds = 0;
  while (events.items.length) {
    const event = events.pop();
    simulationSeconds = Math.max(simulationSeconds, event.time);
    event.execute();
  }

  const expectedJobsPerOrder = 2 + REQUIRED_ACTION_IDS.length * 2 + 2;
  const expectedUniqueJobs = orders * expectedJobsPerOrder;
  const lastArrivalAt = orders === 1 ? 0 : arrivalWindowSeconds;
  const endToEndSeconds = completions.map((item) => item.completedAt - item.arrivedAt);
  const poolReports = Object.fromEntries(POOL_NAMES.map((name) => [name, pools[name].report(simulationSeconds)]));
  const gates = {
    allOrdersCompleted: completions.length === orders,
    exactUniqueSideEffects: tasks.size === expectedUniqueJobs,
    duplicatesObserved: duplicateAttempts.queuedOrRunning > 0 && duplicateAttempts.completed > 0,
    drainsWithinTarget: simulationSeconds - lastArrivalAt <= maxDrainSeconds,
    endToEndWithinTarget: Math.max(0, ...endToEndSeconds) <= maxEndToEndSeconds,
    queueWaitWithinTarget: POOL_NAMES.every((name) => poolReports[name].maxWaitSeconds <= maxQueueWaitSeconds),
    queueDepthWithinTarget: POOL_NAMES.every((name) => poolReports[name].maxQueueDepth <= poolReports[name].maxQueueDepthGate),
    utilizationWithinTarget: POOL_NAMES.every((name) => poolReports[name].utilization <= config.maxUtilization)
  };

  return {
    ok: Object.values(gates).every(Boolean),
    scenario: {
      orders,
      arrivalWindowSeconds,
      arrivalBurstSize,
      actionsPerOrder: REQUIRED_ACTION_IDS.length,
      expectedUniqueJobs,
      maxDrainSeconds,
      maxEndToEndSeconds,
      maxQueueWaitSeconds
    },
    summary: {
      completedOrders: completions.length,
      uniqueJobs: tasks.size,
      duplicateAttempts,
      duplicateExecutions: Math.max(0, tasks.size - expectedUniqueJobs),
      simulationSeconds,
      drainSeconds: Math.max(0, simulationSeconds - lastArrivalAt),
      maxEndToEndSeconds: Math.max(0, ...endToEndSeconds),
      p95EndToEndSeconds: percentile(endToEndSeconds, 0.95),
      providerCalls: poolReports.image.completed + poolReports.video.completed
    },
    pools: poolReports,
    gates
  };
}

module.exports = {
  DEFAULT_CAPACITY_SCENARIO,
  POOL_NAMES,
  simulatePetPackCapacity
};
