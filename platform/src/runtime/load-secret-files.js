const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SECRET_FILE_MAPPINGS = Object.freeze({
  PETPACK_POSTGRES_URL: "PETPACK_POSTGRES_URL_FILE",
  PETPACK_POSTGRES_CA_PEM: "PETPACK_POSTGRES_CA_PEM_FILE",
  PETPACK_REDIS_URL: "PETPACK_REDIS_URL_FILE",
  PETPACK_REDIS_CA_PEM: "PETPACK_REDIS_CA_PEM_FILE",
  PETPACK_SESSION_SIGNING_KEY: "PETPACK_SESSION_SIGNING_KEY_FILE",
  PETPACK_STUDIO_INTERNAL_TOKEN: "PETPACK_STUDIO_INTERNAL_TOKEN_FILE",
  PETPACK_OBJECT_STORE_ACCESS_KEY_ID: "PETPACK_OBJECT_STORE_ACCESS_KEY_ID_FILE",
  PETPACK_OBJECT_STORE_SECRET_ACCESS_KEY: "PETPACK_OBJECT_STORE_SECRET_ACCESS_KEY_FILE",
  MODELARK_API_KEY: "MODELARK_API_KEY_FILE",
  MODELARK_VIDEO_CALLBACK_SECRET: "MODELARK_VIDEO_CALLBACK_SECRET_FILE",
  KAIPAY_CREDENTIALS_JSON: "KAIPAY_CREDENTIALS_JSON_FILE",
  PETPACK_PAYMENT_NOTIFICATION_ENCRYPTION_KEY: "PETPACK_PAYMENT_NOTIFICATION_ENCRYPTION_KEY_FILE"
});

function configured(value) {
  return typeof value === "string" && value.length > 0;
}

function readSecretFile(filePath, label) {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} must be an absolute path`);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symbolic file`);
  if (stat.size < 1 || stat.size > 1024 * 1024) throw new Error(`${label} has an invalid byte size`);
  const value = fs.readFileSync(filePath, "utf8").replace(/[\r\n]+$/, "");
  if (!value || value.includes("\u0000")) throw new Error(`${label} is empty or invalid`);
  return value;
}

function hydrateEnvironmentFromSecretFiles({ environment = process.env, mappings = DEFAULT_SECRET_FILE_MAPPINGS } = {}) {
  const hydrated = { ...environment };
  for (const [settingName, fileSettingName] of Object.entries(mappings)) {
    const direct = configured(environment[settingName]);
    const filePath = configured(environment[fileSettingName]) ? environment[fileSettingName].trim() : "";
    if (direct && filePath) throw new Error(`${settingName} and ${fileSettingName} cannot both be configured`);
    if (filePath) hydrated[settingName] = readSecretFile(filePath, fileSettingName);
    delete hydrated[fileSettingName];
  }
  return Object.freeze(hydrated);
}

module.exports = {
  DEFAULT_SECRET_FILE_MAPPINGS,
  hydrateEnvironmentFromSecretFiles,
  readSecretFile
};
