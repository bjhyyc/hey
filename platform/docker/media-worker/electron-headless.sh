#!/bin/sh
# Pinned production Electron launcher for the PetPack interaction runner.
# createElectronInteractionVerifier pins this file's SHA-256 as the Electron
# executable, so any change here invalidates the deployed component manifest
# until it is re-reviewed and re-pinned.
#
# It supplies the headless X display through xvfb-run and disables the
# Chromium SUID sandbox, which cannot operate under the container's
# no-new-privileges and cap-drop hardening; process isolation comes from the
# container boundary plus the runner's own network/permission lockdown.
set -eu
export ELECTRON_DISABLE_SANDBOX=1
export HOME="${TMPDIR:-/tmp}"
exec /usr/bin/xvfb-run -a --server-args="-screen 0 1280x800x24 -nolisten tcp" /app/electron/electron "$@"
