#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
./scripts/build.sh
mkdir -p dist
cp offlineSdk/build/default/outputs/default/offlineSdk.har dist/harmony-offline-sdk-0.1.4.har
cp entry/build/default/outputs/default/entry-default-unsigned.hap dist/harmony-offline-demo-0.1.4-unsigned.hap
cd dist
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 harmony-offline-sdk-0.1.4.har harmony-offline-demo-0.1.4-unsigned.hap > SHA256SUMS
else
  sha256sum harmony-offline-sdk-0.1.4.har harmony-offline-demo-0.1.4-unsigned.hap > SHA256SUMS
fi
