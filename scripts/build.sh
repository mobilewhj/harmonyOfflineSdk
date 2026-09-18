#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
DEVECO_HOME="${DEVECO_HOME:-/Applications/DevEco-Studio.app/Contents}"
export NODE_HOME="${NODE_HOME:-$DEVECO_HOME/tools/node}"
export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-$DEVECO_HOME/sdk}"
export PATH="$NODE_HOME/bin:$DEVECO_HOME/tools/ohpm/bin:$PATH"
HVIGOR="$DEVECO_HOME/tools/hvigor/bin/hvigorw"
test -x "$HVIGOR" || { echo 'Set DEVECO_HOME to the DevEco Studio installation directory.' >&2; exit 1; }
ohpm install --all
"$HVIGOR" --mode module -p product=default -p module=offlineSdk@default -p buildMode=release assembleHar --no-daemon
"$HVIGOR" --mode module -p product=default -p module=entry@default assembleHap --no-daemon
