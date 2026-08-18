const { createKaipayV3Adapters, normalizeChannelRoute, routeForChannel } = require("../providers/kaipay-v3");
const { loadKaipayConfig } = require("../providers/kaipay-payment-provider");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

function assertSceneCapability(providers, { channel, paymentChannel, provider, payMethod, scene }) {
  const route = normalizeChannelRoute(channel || paymentChannel, { provider, payMethod, scene });
  const entry = providers.find((candidate) => candidate && candidate.provider === route.provider);
  const scenes = Array.isArray(entry?.scenes) ? entry.scenes : [];
  const expectedActionType = route.scene === "web" ? "redirect" : "qr_code";
  const matchedScene = scenes.find((candidate) => candidate && candidate.scene === route.scene);
  const requiredFields = Array.isArray(matchedScene?.requiredFields) ? matchedScene.requiredFields : [];
  const requiredRouteFields = route.provider === "fuyou" ? ["notifyUrl", "payMethod"] : ["notifyUrl"];
  if (!entry || !Array.isArray(entry.payMethods) || !entry.payMethods.includes(route.payMethod) ||
      !matchedScene || matchedScene.actionType !== expectedActionType ||
      requiredRouteFields.some((field) => !requiredFields.includes(field))) {
    throw new Error(`Kaipay V3 capabilities do not include ${route.provider}/${route.payMethod}/${route.scene}`);
  }
}

async function runKaipayCapabilitiesProbe({ environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  const config = loadKaipayConfig(hydrated);
  const { kaipayClient } = createKaipayV3Adapters({ config, fetchImpl });
  const result = await kaipayClient.getCapabilities();
  const providers = Array.isArray(result?.providers) ? result.providers : [];
  assertSceneCapability(providers, routeForChannel(config, "ALIPAY"));
  assertSceneCapability(providers, routeForChannel(config, "WXPAY"));
  return Object.freeze({ ok: true });
}

const runKaipayMerchantProbe = runKaipayCapabilitiesProbe;

async function main() {
  try {
    await runKaipayCapabilitiesProbe();
    console.log("kaipay_v3_capabilities=ok");
  } catch (error) {
    console.error(`kaipay_v3_capabilities=fail error=${error?.code || error?.name || "Error"}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = { assertSceneCapability, runKaipayCapabilitiesProbe, runKaipayMerchantProbe };
