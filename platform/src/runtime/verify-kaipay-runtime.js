const { createKaipayEpayV1Adapters } = require("../providers/kaipay-epay-v1");
const { loadKaipayConfig } = require("../providers/kaipay-payment-provider");
const { hydrateEnvironmentFromSecretFiles } = require("./load-secret-files");

async function runKaipayMerchantProbe({ environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  const hydrated = hydrateEnvironmentFromSecretFiles({ environment });
  const config = loadKaipayConfig(hydrated);
  const { kaipayClient } = createKaipayEpayV1Adapters({ config, fetchImpl });
  const result = await kaipayClient.queryMerchant();
  if (!result || result.ok !== true || result.accountActive !== true) {
    throw new Error("Kaipay merchant probe did not confirm an active account");
  }
  return Object.freeze({ ok: true });
}

async function main() {
  try {
    await runKaipayMerchantProbe();
    console.log("kaipay_merchant=ok");
  } catch (error) {
    console.error(`kaipay_merchant=fail error=${error?.code || error?.name || "Error"}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = { runKaipayMerchantProbe };
