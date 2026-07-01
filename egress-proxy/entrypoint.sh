#!/bin/sh
set -eu

proxy-policy-compiler \
  -out /tmp/envoy.yaml

envoy --mode validate --log-level error -c /tmp/envoy.yaml >/dev/null
exec envoy --log-level error -c /tmp/envoy.yaml
