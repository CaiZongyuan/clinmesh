#!/bin/sh
set -eu

if [ -z "${CLINMESH_REFERENCE_RELEASE_ID:-}" ]; then
  CLINMESH_REFERENCE_RELEASE_ID=$(node -p "JSON.parse(require('node:fs').readFileSync('reference-data.lock.json', 'utf8')).compositeRelease.releaseId")
  export CLINMESH_REFERENCE_RELEASE_ID
fi
node dist/drg-reference-sync.js --database "$CLINMESH_REFERENCE_DATABASE_PATH"
node dist/guideline-prepare.js --database "$CLINMESH_GUIDELINE_DATABASE_PATH"
node dist/database-cli.js migrate --database "$CLINMESH_DATABASE_PATH"
exec node dist/index.js
