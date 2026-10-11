#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR=/app/plugin-registry
export OPENCLAW_DOCKER_E2E_SELECTED_SHA="$1"
export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION="$2"
export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256="$3"

# The repository's supported release-proof wrapper verifies the sealed artifact,
# serves the candidate companion via npm, preserves published baseline versions,
# and reaps its local registry. The published stable executable runs first.
exec bash /source/scripts/e2e/lib/prepublish-plugin-registry.sh \
  openclaw update --channel beta --tag /app/package/candidate.tgz --yes --no-restart --json
