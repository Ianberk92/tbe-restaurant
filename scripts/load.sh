#!/usr/bin/env bash
# Loads any new restaurants/areas from seed/ into the live table.
# Meant for Azure Cloud Shell (already signed in), so it can be typed on a phone:
#   git clone https://github.com/Ianberk92/tbe-restaurant
#   bash tbe-restaurant/scripts/load.sh
# Adds missing rows only; restaurants edited in the app are left alone.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull -q --ff-only origin main 2>/dev/null || true
(cd api && npm ci --silent --no-audit --no-fund)
TABLES_CONNECTION_STRING="$(az staticwebapp appsettings list -n replusdining-swa -g rg-replus-dining \
  --query properties.TABLES_CONNECTION_STRING -o tsv)"
if [ -z "$TABLES_CONNECTION_STRING" ]; then
  echo "Couldn't read the app's connection string. Is this the right Azure subscription? (az account show)" >&2
  exit 1
fi
export TABLES_CONNECTION_STRING
node scripts/seed.js
