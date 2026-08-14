const { KaipayPaymentProvider } = require("./kaipay-payment-provider");
const { SimulatedPaymentProvider } = require("./simulated-payment-provider");

function createPaymentProvider({ config, ...dependencies } = {}) {
  if (!config) throw new Error("Payment configuration is required");
  if (config.mode === "development" && config.allowSimulatedPayments === true) {
    return new SimulatedPaymentProvider({ mode: config.mode, ...dependencies });
  }
  return new KaipayPaymentProvider({ config, ...dependencies });
}

module.exports = { createPaymentProvider };
