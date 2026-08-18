#!/usr/bin/env node

const { ModelArkClient } = require("../providers/modelark-client");
const {
  CONTROLLED_ROOT,
  ControlledCanaryError,
  runControlledCanary
} = require("../canary/controlled-real-modelark-canary");

const REQUIRED_VALUE_FLAGS = Object.freeze(new Set([
  "--front-1",
  "--front-2",
  "--angle-1",
  "--pet-type",
  "--output-root",
  "--budget-cny",
  "--front-image-cny",
  "--side-image-cny",
  "--sleep-image-cny",
  "--video-second-cny",
  "--price-card-version",
  "--price-source-reference",
  "--registry-version",
  "--region",
  "--image-endpoint",
  "--image-size",
  "--video-endpoint",
  "--artifact-host"
]));
const OPTIONAL_VALUE_FLAGS = Object.freeze(new Set([
  "--token-million-cny",
  "--through"
]));
const BOOLEAN_FLAGS = Object.freeze(new Set([
  "--execute",
  "--submit-video-cohort"
]));
const VALUE_FLAGS = Object.freeze(new Set([...REQUIRED_VALUE_FLAGS, ...OPTIONAL_VALUE_FLAGS]));

const USAGE = `Usage:
  node platform/src/runtime/run-controlled-real-modelark-canary.js \\
    --front-1 <absolute-jpeg> --front-2 <absolute-jpeg> --angle-1 <absolute-jpeg> \\
    --pet-type <dog|cat> --output-root <absolute-controlled-child> \\
    --budget-cny 30 --front-image-cny <decimal> --side-image-cny <decimal> \\
    --sleep-image-cny <decimal> --video-second-cny <decimal> \\
    --price-card-version <id> --price-source-reference <reference> \\
    --registry-version <id> --region <id> --image-endpoint <id> \\
    --image-size <size> --video-endpoint <id> --artifact-host <host[,host]> \\
    [--token-million-cny <decimal>] [--execute [--through <stage-id>]]
    [--execute --submit-video-cohort]

Plan-only is the default. Review plan.json before a separate invocation with
--execute. Execution accepts MODELARK_API_KEY only as a direct environment
variable; this command never reads a secret or key file.

output-root must be a strict child of:
  ${CONTROLLED_ROOT}

Reviewed canary example (operator inputs, not production defaults): image prices
0.50/0.50/0.50, video 0.45 per requested second, token observation 46
per million. For the fixed 40 video seconds this plans CNY 19.50; the plan
shows CNY 23.40 after its 20% contingency, below the CNY 24 safety threshold.`;

function cliError(message) {
  const error = new ControlledCanaryError("invalid_cli", message);
  error.showUsage = true;
  return error;
}

function parseCliArgs(argv) {
  if (!Array.isArray(argv)) throw cliError("CLI arguments are invalid");
  const values = new Map();
  let execute = false;
  let submitVideoCohort = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (BOOLEAN_FLAGS.has(token)) {
      if (token === "--execute") {
        if (execute) throw cliError("--execute may be supplied only once");
        execute = true;
      } else {
        if (submitVideoCohort) throw cliError("--submit-video-cohort may be supplied only once");
        submitVideoCohort = true;
      }
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(token)) throw cliError(`Unknown option: ${token}`);
    if (values.has(token)) throw cliError(`${token} may be supplied only once`);
    const value = argv[index + 1];
    if (typeof value !== "string" || !value || value.startsWith("--")) {
      throw cliError(`${token} requires a value`);
    }
    values.set(token, value);
    index += 1;
  }
  if (help) return Object.freeze({ help: true, execute: false });
  for (const flag of REQUIRED_VALUE_FLAGS) {
    if (!values.has(flag)) throw cliError(`${flag} is required`);
  }
  return Object.freeze({
    help: false,
    execute,
    submitVideoCohort,
    through: values.get("--through") || null,
    inputPaths: Object.freeze({
      front1: values.get("--front-1"),
      front2: values.get("--front-2"),
      angle1: values.get("--angle-1")
    }),
    petType: values.get("--pet-type"),
    outputRoot: values.get("--output-root"),
    priceCard: Object.freeze({
      budgetCny: values.get("--budget-cny"),
      frontImageCny: values.get("--front-image-cny"),
      sideImageCny: values.get("--side-image-cny"),
      sleepImageCny: values.get("--sleep-image-cny"),
      videoSecondCny: values.get("--video-second-cny"),
      version: values.get("--price-card-version"),
      sourceReference: values.get("--price-source-reference")
      ,
      tokenMillionCny: values.get("--token-million-cny") || null
    }),
    model: Object.freeze({
      registryVersion: values.get("--registry-version"),
      region: values.get("--region"),
      seedreamEndpointId: values.get("--image-endpoint"),
      seedreamOutputSize: values.get("--image-size"),
      seedanceEndpointId: values.get("--video-endpoint"),
      videoResolution: "480p",
      artifactHosts: values.get("--artifact-host").split(",").map((value) => value.trim()).filter(Boolean)
    })
  });
}

function assertNoSecretFileConfiguration(environment) {
  for (const [name, value] of Object.entries(environment || {})) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (/^MODELARK_.*(?:KEY|SECRET).*_FILE$/i.test(name) || /^MODELARK_.*_FILE$/i.test(name)) {
      throw new ControlledCanaryError(
        "secret_file_forbidden",
        `${name} is forbidden; the controlled canary never reads key or secret files`
      );
    }
  }
}

function createExecutionClient(parsed, environment = process.env) {
  assertNoSecretFileConfiguration(environment);
  const apiKey = typeof environment.MODELARK_API_KEY === "string"
    ? environment.MODELARK_API_KEY.trim()
    : "";
  if (!apiKey || /[\r\n]/.test(apiKey)) {
    throw new ControlledCanaryError(
      "missing_direct_api_key",
      "--execute requires MODELARK_API_KEY as a direct environment variable"
    );
  }
  const registry = {
    version: parsed.model.registryVersion,
    mode: "production",
    modelArk: {
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      region: parsed.model.region,
      apiKey,
      image: {
        endpointId: parsed.model.seedreamEndpointId,
        outputSize: parsed.model.seedreamOutputSize,
        maxConcurrent: 1,
        maxRetries: 0
      },
      video: {
        endpointId: parsed.model.seedanceEndpointId,
        resolution: "480p",
        maxConcurrent: 1,
        maxRetries: 0,
        callbackBaseUrl: "",
        callbackSecret: ""
      }
    }
  };
  return new ModelArkClient({
    registry,
    fetchImpl: createTimedFetch(globalThis.fetch),
    logger: {
      info(event, fields) {
        process.stderr.write(`${JSON.stringify({ level: "info", event, requestId: fields?.requestId || null })}\n`);
      },
      warn(event, fields) {
        process.stderr.write(`${JSON.stringify({ level: "warn", event, requestId: fields?.requestId || null, status: fields?.status || null })}\n`);
      }
    }
  });
}

function createTimedFetch(fetchImpl, timeoutMs = 180_000) {
  if (typeof fetchImpl !== "function") throw new ControlledCanaryError("missing_fetch", "A server-side fetch implementation is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new ControlledCanaryError("invalid_timeout", "ModelArk request timeout must be between 1 and 300000 milliseconds");
  }
  return (url, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return fetchImpl(url, { ...init, signal });
  };
}

function safeSummary(result) {
  return {
    mode: result.mode,
    contractVersion: result.plan.contractVersion,
    planHash: result.plan.planHash,
    outputRoot: result.plan.outputRoot,
    runStatus: result.state.runStatus,
    projectedCostCny: result.plan.projectedCostCny,
    committedCostCny: result.state.committedCostCny,
    completedStages: result.state.completedStages,
    nextStep: result.mode === "plan"
      ? "Review plan.json, state.json, and audit.json; rerun the identical command with --execute only after approval."
      : null
  };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    (dependencies.stdout || process.stdout).write(`${USAGE}\n`);
    return Object.freeze({ help: true });
  }
  if (!parsed.execute && parsed.through) {
    throw cliError("--through is valid only together with --execute");
  }
  if (parsed.submitVideoCohort && !parsed.execute) {
    throw cliError("--submit-video-cohort is valid only together with --execute");
  }
  if (parsed.submitVideoCohort && parsed.through) {
    throw cliError("--submit-video-cohort cannot be combined with --through");
  }
  const environment = dependencies.environment || process.env;
  // Secret-file variables are rejected in both modes so operators do not
  // mistake this runner for a file-hydrating entrypoint. Plan mode still does
  // not require, inspect, or instantiate an API key/client.
  assertNoSecretFileConfiguration(environment);
  let modelArkClient = dependencies.modelArkClient;
  if (parsed.execute && !modelArkClient) {
    modelArkClient = (dependencies.createExecutionClient || createExecutionClient)(parsed, environment);
  }
  const result = await (dependencies.runControlledCanary || runControlledCanary)(parsed, {
    modelArkClient,
    ...(dependencies.runnerDependencies || {})
  });
  (dependencies.stdout || process.stdout).write(`${JSON.stringify(safeSummary(result), null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "controlled_canary_failed";
    process.stderr.write(`${JSON.stringify({ error: code, message: error?.message || "Controlled canary failed" })}\n`);
    if (error?.showUsage) process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  USAGE,
  assertNoSecretFileConfiguration,
  createExecutionClient,
  createTimedFetch,
  main,
  parseCliArgs,
  safeSummary
};
