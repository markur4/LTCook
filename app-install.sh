#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$HERE/src/ltcook_distr/artifacts/installer/bootstrap.sh" "$@"
