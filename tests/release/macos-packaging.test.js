import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
describe('macOS packaging contract', () => {
  it('matches the shipping product identity and stays isolated', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    const cfg = fs.readFileSync(path.join(root, 'build/electron-builder.mac.yml'), 'utf8');
    expect(cfg).toContain(`appId: ${pkg.build.appId}`);
    expect(cfg).toContain(`productName: ${pkg.build.productName}`);
    for (const file of pkg.build.files) expect(cfg).toContain(`  - ${file}`);
    expect(cfg).toContain('hardenedRuntime: true');
    expect(cfg).not.toContain('identity: null');
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/release-macos.yml'), 'utf8');
    expect(workflow).toContain("'mac/v*'");
    expect(workflow).not.toMatch(/tags:\s*\[['"]v\*/);
  });
});
