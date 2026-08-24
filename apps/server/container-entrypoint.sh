#!/bin/sh
set -eu

node dist/database-cli.js migrate --database "$CLINMESH_DATABASE_PATH"
exec node dist/index.js
