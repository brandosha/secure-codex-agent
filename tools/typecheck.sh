#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if [ ! -x ./node_modules/.bin/tsc ]; then
  pnpm install
fi

./node_modules/.bin/tsc --noEmit
