#!/usr/bin/env node
/**
 * Экспорт всех таблиц Postgres (видимых роли подключения) в JSON в backups/tables-YYYYMMDD-HHMMSS/
 * Читает DATABASE_URL из .env.backup — см. .env.backup.example
 */
import { readFileSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const { Client } = pg

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const ENV_PATH = process.env.SUPABASE_BACKUP_ENV || join(ROOT, '.env.backup')

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  let raw
  try {
    raw = readFileSync(ENV_PATH, 'utf8')
  } catch {
    console.error(
      `Задайте DATABASE_URL в окружении или создайте ${ENV_PATH} (см. .env.backup.example).`
    )
    process.exit(1)
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = /^DATABASE_URL=(.*)$/.exec(t)
    if (!m) continue
    let v = m[1].trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    if (v) return v
  }
  console.error(`В ${ENV_PATH} не найдена переменная DATABASE_URL.`)
  process.exit(1)
}

function qIdent(part) {
  return `"${String(part).replace(/"/g, '""')}"`
}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value))
    return { __type: 'bytea', base64: value.toString('base64') }
  return value
}

async function main() {
  const databaseUrl = loadDatabaseUrl()
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const outDir = join(ROOT, 'backups', `tables-${stamp}`)
  mkdirSync(outDir, { recursive: true })

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  const { rows: tables } = await client.query(`
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY schemaname, tablename
  `)

  const manifest = { createdAt: new Date().toISOString(), tables: [] }

  for (const { schemaname, tablename } of tables) {
    const label = `${schemaname}.${tablename}`
    const safeFile = `${schemaname}.${tablename}`.replace(/[^a-zA-Z0-9._-]/g, '_')
    try {
      const sql = `SELECT * FROM ${qIdent(schemaname)}.${qIdent(tablename)}`
      const { rows } = await client.query(sql)
      const body = JSON.stringify(rows, jsonReplacer, 2)
      writeFileSync(join(outDir, `${safeFile}.json`), body, 'utf8')
      manifest.tables.push({ name: label, rows: rows.length, file: `${safeFile}.json` })
      console.log(label, rows.length, 'строк')
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      manifest.tables.push({ name: label, error: errMsg })
      console.error(label, 'ошибка:', errMsg)
    }
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  await client.end()
  console.log('Готово:', outDir)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
