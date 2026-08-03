#!/usr/bin/env bash
# Create (or re-create) the restricted `app_user` Postgres role for one Ask
# stack and print the DATABASE_RESTRICTED_URL line to add to that stack's .env.
#
# Why this role exists: the app's RLS policies only take effect when the runtime
# connects as a NON-superuser, NON-bypassrls role. Connecting as the owner
# (morphic) silently disables every policy. app_user is that restricted role.
# Migrations and the file/ingest worker keep using the owner via DATABASE_URL
# (the dbAdmin client); only the user-facing runtime uses app_user.
#
#   ./create-app-user.sh <postgres-container>
#     e.g. ./create-app-user.sh ask-postgres            (prod)
#          ./create-app-user.sh ask-postgres-admin-feature   (staging)
#          ./create-app-user.sh ask-postgres-lab        (lab)
#
# Idempotent: DROP ... IF EXISTS then CREATE. The password is freshly generated
# each run and never printed except inside the URL line you paste into .env.
set -euo pipefail

CONTAINER="${1:?usage: create-app-user.sh <postgres-container>}"
DB="${POSTGRES_DB:-morphic}"
OWNER="${POSTGRES_USER:-morphic}"

command -v openssl >/dev/null || { echo "openssl required" >&2; exit 1; }
PW="$(openssl rand -hex 24)"

docker exec -i "$CONTAINER" psql -U "$OWNER" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "DROP ROLE IF EXISTS app_user;" \
  -c "CREATE ROLE app_user LOGIN PASSWORD '${PW}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;" \
  -c "GRANT USAGE ON SCHEMA public TO app_user;" \
  -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;" \
  -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;" \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;" \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;" \
  >/dev/null

# Confirm the role is genuinely unprivileged — the whole point.
ATTRS="$(docker exec "$CONTAINER" psql -U "$OWNER" -d "$DB" -tAF' ' \
  -c "select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname='app_user';")"
echo "app_user attributes (super bypassrls canlogin): ${ATTRS}"
[ "${ATTRS// /}" = "fft" ] || { echo "ERROR: app_user is not correctly unprivileged" >&2; exit 1; }

echo
echo "Add this line to the stack's .env (it holds the secret; .env is gitignored):"
echo "DATABASE_RESTRICTED_URL=postgresql://app_user:${PW}@postgres:5432/${DB}"
