#!/usr/bin/env bash
# Полный логический дамп PostgreSQL проекта Supabase (схемы + данные).
# Требуется: установленный pg_dump (PostgreSQL client tools).
#
# 1) Скопируйте .env.backup.example → .env.backup и вставьте DATABASE_URL из Supabase
#    (Settings → Database → Connection string → URI, Direct connection).
# 2) Запуск: из корня репозитория: ./scripts/backup-supabase-db.sh
#    или: bash scripts/backup-supabase-db.sh
#
# Файл попадёт в backups/ (папка в .gitignore).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "Ошибка: не найден pg_dump. Установите PostgreSQL client (например: brew install libpq && brew link --force libpq)" >&2
  exit 1
fi

ENV_FILE="${SUPABASE_BACKUP_ENV:-$ROOT/.env.backup}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Создайте файл $ENV_FILE (скопируйте из .env.backup.example) с DATABASE_URL." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "В $ENV_FILE должна быть переменная DATABASE_URL (URI подключения к Postgres Supabase)." >&2
  exit 1
fi

OUT_DIR="$ROOT/backups"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
SQL_FILE="$OUT_DIR/supabase-full-${STAMP}.sql"
CUSTOM_FILE="$OUT_DIR/supabase-full-${STAMP}.dump"

echo "Дамп в $SQL_FILE (plain SQL) и $CUSTOM_FILE (custom format для pg_restore)..."

# Plain SQL — удобно просматривать и выполнять частями в SQL Editor при необходимости
pg_dump "$DATABASE_URL" \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  -F p \
  -f "$SQL_FILE"

# Custom — компактный бинарный дамп для pg_restore на другой инстанс
pg_dump "$DATABASE_URL" \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  -F c \
  -f "$CUSTOM_FILE"

echo "Готово."
echo "  SQL:    $SQL_FILE"
echo "  Custom: $CUSTOM_FILE"
echo "Храните копии вне репозитория или в зашифрованном хранилище. Папка backups/ в .gitignore."
