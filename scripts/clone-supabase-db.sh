#!/usr/bin/env bash
# Копия БД PostgreSQL с одного проекта Supabase на другой (или только дамп в backups/).
#
# Источник: https://zvruiqnwaayxrddqgmsv.supabase.co → Direct connection:
#   postgresql://postgres:ПАРОЛЬ@db.zvruiqnwaayxrddqgmsv.supabase.co:5432/postgres
# Пароль: Supabase → Project Settings → Database → Database password.
#
# Примеры:
#   Только сохранить дамп в backups/:
#     SOURCE_DATABASE_URL='postgresql://postgres:...@db.zvruiqnwaayxrddqgmsv.supabase.co:5432/postgres' \
#       ./scripts/clone-supabase-db.sh
#
#   Скопировать в другой проект (цель — пароль от целевого проекта):
#     SOURCE_DATABASE_URL='postgresql://postgres:SRC@db.zvruiqnwaayxrddqgmsv.supabase.co:5432/postgres' \
#     TARGET_DATABASE_URL='postgresql://postgres:DST@db.ВАШ_ЦЕЛЕВОЙ_REF.supabase.co:5432/postgres' \
#       ./scripts/clone-supabase-db.sh
#
# Внимание: полный дамп включает схемы вне public (auth, storage, …). Восстановление в другой Supabase
# иногда падает на системных объектах — тогда делайте дамп только public (см. комментарий в конце файла).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v pg_dump >/dev/null 2>&1 || ! command -v pg_restore >/dev/null 2>&1; then
  echo "Нужны pg_dump и pg_restore (brew install libpq && brew link --force libpq)" >&2
  exit 1
fi

SOURCE="${SOURCE_DATABASE_URL:-}"
TARGET="${TARGET_DATABASE_URL:-}"

if [[ -z "$SOURCE" ]]; then
  echo "Задайте SOURCE_DATABASE_URL — URI Direct connection к БД-источнику." >&2
  exit 1
fi

OUT_DIR="$ROOT/backups"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="$OUT_DIR/supabase-clone-${STAMP}.dump"

echo "Дамп источника → $DUMP_FILE ..."
pg_dump "$SOURCE" \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  -F c \
  -f "$DUMP_FILE"

echo "Готово: $DUMP_FILE"

if [[ -z "$TARGET" ]]; then
  echo ""
  echo "Цель не задана. Чтобы восстановить в другой проект:"
  echo "  TARGET_DATABASE_URL='postgresql://postgres:ПАРОЛЬ@db.REF.supabase.co:5432/postgres' \\"
  echo "    ./scripts/restore-supabase-db.sh \"$DUMP_FILE\""
  exit 0
fi

echo "Восстановление в целевую БД..."
pg_restore --clean --if-exists --no-owner --no-acl -d "$TARGET" "$DUMP_FILE"
echo "Готово: данные залиты в целевой проект."

# Если pg_restore упал на auth/storage/realtime:
# сделайте дамп только схемы приложения:
#   pg_dump "$SOURCE" --no-owner --no-acl --schema=public -F c -f public-only.dump
# и восстановите: pg_restore -d "$TARGET" public-only.dump
