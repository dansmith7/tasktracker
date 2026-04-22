#!/usr/bin/env bash
# Восстановление из custom-дампа (.dump), созданного backup-supabase-db.sh
# Целевой URL — другой проект Supabase или локальный Postgres (для теста).
#
# Использование:
#   TARGET_DATABASE_URL='postgresql://...' ./scripts/restore-supabase-db.sh backups/supabase-full-YYYYMMDD-HHMMSS.dump
#
# Внимание: перезапишет объекты в целевой БД согласно дампу. Делайте на пустой БД или осознанно.

set -euo pipefail

if [[ -z "${TARGET_DATABASE_URL:-}" ]]; then
  echo "Задайте TARGET_DATABASE_URL — строку подключения к целевой БД." >&2
  echo "Пример: TARGET_DATABASE_URL='postgresql://postgres:pwd@db.xxx.supabase.co:5432/postgres' $0 файл.dump" >&2
  exit 1
fi

DUMP="${1:-}"
if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Укажите путь к .dump файлу: $0 backups/supabase-full-....dump" >&2
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "Ошибка: не найден pg_restore." >&2
  exit 1
fi

echo "Восстановление в целевую БД (из $DUMP)..."
pg_restore --clean --if-exists --no-owner --no-acl -d "$TARGET_DATABASE_URL" "$DUMP"
echo "Готово."
