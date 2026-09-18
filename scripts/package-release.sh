#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
./scripts/build.sh
mkdir -p dist
cp offlineSdk/build/default/outputs/default/offlineSdk.har dist/com.offline.demo-0.1.1.har
cp entry/build/default/outputs/default/entry-default-unsigned.hap dist/harmony-offline-demo-0.1.1-unsigned.hap
cd dist
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 com.offline.demo-0.1.1.har harmony-offline-demo-0.1.1-unsigned.hap > SHA256SUMS
else
  sha256sum com.offline.demo-0.1.1.har harmony-offline-demo-0.1.1-unsigned.hap > SHA256SUMS
fi
