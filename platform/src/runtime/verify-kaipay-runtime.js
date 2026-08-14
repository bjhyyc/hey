const { createKaipayV3Adapters, providerForChannel } = require("../providers/kaipay-v3");
const { loadKaipayConfig } = require("../providers/kaipay-payment-provider");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

function assertSceneCapability(providers, { channel, scene }) {
  const provider = providerForChannel(channel);
  const entry = providers.find((candidate) => candidate && candidate.provider === provider);
  const scenes = Array.isArray(entry?.scenes) ? entry.scenes : [];
  const payMethod = channel === "ALIPAY" ? "alipay" : "wechat";
  const expectedActionType = scene === "web" ? "redirect" : "qr_code";
  const matchedScene = scenes.find((candidate) => candidate && candidate.scene === scene);
  const requiredFields = Array.isArray(matchedScene?.requiredFields) ? matchedScene.requiredFields : [];
  if (!entry || !Array.isArray(entry.payMethods) || !entry.payMethods.includes(payMethod) ||
      !matchedScene || matchedScene.actionType !== expectedActionType || !requiredFields.includes("notifyUrl")) {
    throw new Error(`Kaipay V3 capabilities do not include ${provider}/${scene}`);
  }
}

async function runKaipayCapabilitiesProbe({ environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  const config = loadKaipayConfig(hydrated);
  const { kaipayClient } = createKaipayV3Adapters({ config, fetchImpl });
  const result = await kaipayClient.getCapabilities();
  const providers = Array.isArray(result?.providers) ? result.providers : [];
  assertSceneCapability(providers, { channel: "ALIPAY", scene: config.alipayScene });
  assertSceneCapability(providers, { channel: "WXPAY", scene: config.wechatScene });
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
