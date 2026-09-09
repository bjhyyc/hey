#!/usr/bin/env bash
set -euo pipefail
npx electron-builder --config build/electron-builder.mac.yml --mac --universal
shasum -a 256 release-mac/*.dmg
