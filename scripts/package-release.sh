#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test "$#" -eq 0 || { printf '%s\n' 'Usage: scripts/package-release.sh' >&2; exit 2; }
sdk_package_version=$(python3 - <<'CHECK'
import json, re
from pathlib import Path
metadata = json.loads(Path('offlineSdk/oh-package.json5').read_text())
if metadata.get('name') != 'com.offline.tool':
    raise SystemExit('Unexpected SDK package name')
version = metadata.get('version', '')
if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?', version):
    raise SystemExit('SDK version must be a filename-safe semantic version')
for name in ['CHANGELOG.md', 'offlineSdk/CHANGELOG.md']:
    if '## ' + version not in Path(name).read_text().splitlines():
        raise SystemExit(name + ' must include the exact current-version heading')
print(version)
CHECK
)
release_dir="dist/release-$sdk_package_version"
test ! -e "$release_dir" || { printf '%s\n' 'Release output already exists; preserve it and use a clean preparation workspace.' >&2; exit 2; }
python3 scripts/generate-sample.py --check
DEVECO_HOME="${DEVECO_HOME:-/Applications/DevEco-Studio.app/Contents}"
export NODE_HOME="${NODE_HOME:-$DEVECO_HOME/tools/node}"
export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-$DEVECO_HOME/sdk}"
export PATH="$NODE_HOME/bin:$DEVECO_HOME/tools/ohpm/bin:$PATH"
hvigor_release="$DEVECO_HOME/tools/hvigor/bin/hvigorw"
test -x "$hvigor_release" || { printf '%s\n' 'Set DEVECO_HOME to the DevEco Studio installation directory.' >&2; exit 1; }
ohpm install --all
"$hvigor_release" --mode module -p product=default -p module=offlineSdk@default -p buildMode=release assembleHar --no-daemon
sdk_built_har='offlineSdk/build/default/outputs/default/offlineSdk.har'
python3 - "$sdk_built_har" "$sdk_package_version" <<'VERIFY'
import json, sys, tarfile
from pathlib import PurePosixPath
with tarfile.open(sys.argv[1], 'r:*') as archive:
    members = [m for m in archive.getmembers() if m.isfile() and str(PurePosixPath(m.name)) in ['package/oh-package.json5', 'oh-package.json5']]
    if len(members) != 1:
        raise SystemExit('HAR must contain one root package metadata file')
    metadata = json.loads(archive.extractfile(members[0]).read())
    if metadata.get('name') != 'com.offline.tool' or metadata.get('version') != sys.argv[2]:
        raise SystemExit('Built HAR package identity does not match source metadata')
VERIFY
mkdir -p dist
mkdir "$release_dir"
cp "$sdk_built_har" "$release_dir/com.offline.tool-$sdk_package_version.har"
(
  cd "$release_dir"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "com.offline.tool-$sdk_package_version.har" > SHA256SUMS
  else
    sha256sum "com.offline.tool-$sdk_package_version.har" > SHA256SUMS
  fi
)
printf 'Prepared %s\n' "$release_dir"
