#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 - <<'CHECK'
import json
from pathlib import Path
metadata = json.loads(Path('offlineSdk/oh-package.json5').read_text())
version = metadata['version']
assert ('## ' + version) in Path('offlineSdk/CHANGELOG.md').read_text().splitlines(), 'SDK CHANGELOG must include the current version'
CHECK
./scripts/build.sh
mkdir -p dist
cp offlineSdk/build/default/outputs/default/offlineSdk.har dist/com.offline.tool-0.2.0.har
cp entry/build/default/outputs/default/entry-default-unsigned.hap dist/harmony-offline-demo-0.2.0-unsigned.hap
cd dist
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 com.offline.tool-0.2.0.har harmony-offline-demo-0.2.0-unsigned.hap > SHA256SUMS
else
  sha256sum com.offline.tool-0.2.0.har harmony-offline-demo-0.2.0-unsigned.hap > SHA256SUMS
fi
