import type { Settings } from '../../shared/api'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import type { Db } from './db'

export function getSettings(db: Db): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) }
}

export function saveSettings(db: Db, settings: Partial<Settings>): void {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
  for (const [key, value] of Object.entries(settings)) stmt.run(key, JSON.stringify(value))
}
