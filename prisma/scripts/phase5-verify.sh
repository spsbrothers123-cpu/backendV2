#!/usr/bin/env bash
# Egg Mart V2.0 — Cashier Recovery, Phase 5: full verification against a LOCAL TEST database.
# Never touches production: refuses to run unless DATABASE_URL is localhost and the DB name contains "test".
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.test ] || { echo "Missing .env.test (local test DB settings)."; exit 1; }
set -a; . ./.env.test; set +a

case "${DATABASE_URL:-}" in
  *@localhost:*/*test*|*@127.0.0.1:*/*test*) ;;
  *) echo "REFUSING: DATABASE_URL must be a local database whose name contains 'test'."; exit 1 ;;
esac

export NODE_ENV=test RUN_INTEGRATION_TESTS=1
echo "== 1/4 prisma generate";                         npx prisma generate
echo "== 2/4 apply migrations to the TEST database";   npx prisma migrate deploy
echo "== 3/4 type-check";                              npx tsc --noEmit -p tsconfig.json
echo "== 4/4 full suite (recovery + regression)"
npx vitest run --reporter=verbose 2>&1 | tee phase5-results.txt
echo
echo "Done. Send me phase5-results.txt and I will fill in the matrix."
