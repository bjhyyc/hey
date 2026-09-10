import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(require.resolve("../../package.json")));
const CLIENT_ROOT = path.join(ROOT, "src");

// This client is a derivative of an upstream desktop-pet project, and for a
// long time it still wore that project's clothes where customers could see
// them: the panel's own heading and the tray tooltip read "Desktop Pet", and
// the About panel offered that project's website, repository and changelog.
// The update check was the worst of it - it compared this build against
// another product's version line, so a release there would have told our
// customers to update and sent them somewhere else entirely.
//
// Attribution belongs in the licence and the README, which is where the GPL
// requires it and where it stays. It does not belong in the running product.

// Deliberately not a bare /desktop-pet/: that slug is load-bearing inside the
// client as an identifier rather than a reference - the exported rules file
// declares the type "desktop-pet.triggerRules", the log files and the version
// argument are named from it - and renaming those would reject files customers
// already hold. What is forbidden is naming the upstream project: its account,
// its repository, and the product name as it is displayed.
const FORBIDDEN = [
  { pattern: /duzexu/i, what: "the upstream account" },
  { pattern: /desktop-pet\/(releases|blob|tree|issues)/i, what: "the upstream repository" },
  { pattern: /Desktop Pet/, what: "the upstream product name" }
];

/** Every shipped client source file, excluding build output. */
function clientSources(directory = CLIENT_ROOT, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      clientSources(full, found);
      continue;
    }
    if (/\.(js|html|css|json)$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe("the shipped client wears its own name", () => {
  const files = clientSources();

  it("finds the client sources to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("names no upstream project anywhere under src/", () => {
    const offences = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const lines = source.split("\n");
      for (const { pattern, what } of FORBIDDEN) {
        lines.forEach((line, index) => {
          if (pattern.test(line)) {
            offences.push(`${path.relative(ROOT, file).replace(/\\/g, "/")}:${index + 1} names ${what}`);
          }
        });
      }
    }
    expect(offences).toEqual([]);
  });

  it("rejects the shapes that were actually shipped", () => {
    // A guard on the guard, in the exact forms this repo carried.
    const shipped = [
      'localTray.setToolTip("Desktop Pet");',
      "<h1>Desktop Pet</h1>",
      'website: "https://duzexu.github.io/desktop-pet/",',
      "https://api.github.com/repos/duzexu/desktop-pet/releases/latest"
    ];
    for (const line of shipped) {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(line)), line).toBe(true);
    }
  });
});
