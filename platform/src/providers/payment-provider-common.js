const crypto = require("node:crypto");

function digestNotification(rawNotification) {
  const material = typeof rawNotification === "string" || Buffer.isBuffer(rawNotification)
    ? rawNotification
    : JSON.stringify(rawNotification || {});
  return crypto.createHash("sha256").update(material).digest("hex");
}

module.exports = { digestNotification };
