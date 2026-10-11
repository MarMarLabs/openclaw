#!/usr/bin/env bash
set -euo pipefail

# Existing repository prerequisite from .github/actions/setup-ripgrep/action.yml.
# Keep the same version, static Linux/X64 archive and SHA-256 as the beta base.
[[ "$(uname -s)/$(uname -m)" == "Linux/x86_64" ]]
mkdir -p /app/tools
curl --fail --location --retry 3 --connect-timeout 15 --max-time 120 \
  https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz \
  --output /app/tools/ripgrep.tar.gz
printf '%s  %s\n' \
  4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e \
  /app/tools/ripgrep.tar.gz | sha256sum --check --strict
tar -xzf /app/tools/ripgrep.tar.gz -C /app/tools --strip-components=1 \
  ripgrep-14.1.1-x86_64-unknown-linux-musl/rg
sha256sum /app/tools/ripgrep.tar.gz /app/tools/rg
/app/tools/rg --version
