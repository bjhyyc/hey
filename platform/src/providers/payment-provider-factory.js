const { KaipayPaymentProvider } = require("./kaipay-payment-provider");
const { createKaipayEpayV1Adapters } = require("./kaipay-epay-v1");
const { SimulatedPaymentProvider } = require("./simulated-payment-provider");

function createPaymentProvider({ config, ...dependencies } = {}) {
  if (!config) throw new Error("Payment configuration is required");
  if (config.mode === "development" && config.allowSimulatedPayments === true) {
    return new SimulatedPaymentProvider({ mode: config.mode, ...dependencies });
  }
  const injectedClient = dependencies.kaipayClient;
  const injectedProtocol = dependencies.notificationProtocol;
  if (Boolean(injectedClient) !== Boolean(injectedProtocol)) {
    throw new Error("Kaipay client and notification protocol must be injected together");
  }
  const adapters = injectedClient
    ? { kaipayClient: injectedClient, notificationProtocol: injectedProtocol }
    : createKaipayEpayV1Adapters({ config, fetchImpl: dependencies.fetchImpl });
  return new KaipayPaymentProvider({ config, ...dependencies, ...adapters });
}

module.exports = { createPaymentProvider };
