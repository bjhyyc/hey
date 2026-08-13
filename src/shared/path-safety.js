const path = require("node:path");

function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return false;

  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }

  return path.posix.normalize(value) === value;
}

module.exports = { isSafeRelativePath };
