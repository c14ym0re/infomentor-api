// SQLite-arkiv (node:sqlite — inbyggt, inga beroenden).
//
//  items    — aktuellt läge per post (för diffning), generisk med JSON-data
//  events   — append-only händelselogg (historiken/sökningen)
//  meta     — nyckel/värde (senaste poll, etc.)
//
// JSON-fälten är querybara med SQLite:s json_extract(), så historiken går att
// söka i utan att låsa schemat.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  child      TEXT,
  first_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind);
CREATE INDEX IF NOT EXISTS idx_items_child ON items(child);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  type       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  child      TEXT,
  item_key   TEXT,
  title      TEXT,
  priority   TEXT NOT NULL,
  data       TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_delivered ON events(delivered_at);
CREATE INDEX IF NOT EXISTS idx_events_child ON events(child);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

export class Store {
  /** @param {string} path filväg, eller ':memory:' */
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  close() {
    this.db.close()
  }

  /**
   * Posttyper som redan fått sin baslinje (se events.seedNewKinds). Saknas metan
   * — t.ex. första körningen efter att en ny typ börjat samlas in — utgår vi
   * från typerna i arkivet, så att bara genuint nya typer får en baslinje i
   * stället för att varenda typ tystas en gång.
   */
  seededKinds() {
    const meta = this.getMeta('seededKinds')
    if (meta !== null) return new Set(meta.split(',').filter(Boolean))
    return new Set([...this.getPrevIndex().values()].map((i) => i.kind))
  }

  /** Föregående läge som ett index nycklat på item.key — för diffning. */
  getPrevIndex() {
    const rows = this.db.prepare('SELECT key, data FROM items').all()
    const map = new Map()
    for (const r of rows) map.set(r.key, JSON.parse(r.data))
    return map
  }

  /** Ersätter/uppdaterar aktuella poster. first_seen bevaras. */
  applyItems(items, now = new Date().toISOString()) {
    const upsert = this.db.prepare(`
      INSERT INTO items (key, kind, child, first_seen, updated_at, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        kind = excluded.kind,
        child = excluded.child,
        updated_at = excluded.updated_at,
        data = excluded.data
    `)
    const existing = this.db.prepare('SELECT key FROM items')
    const have = new Set(existing.all().map((r) => r.key))

    let inserted = 0
    let updated = 0
    this.db.exec('BEGIN')
    try {
      for (const it of items) {
        const existed = have.has(it.key)
        upsert.run(it.key, it.kind, it.child ?? null, now, now, JSON.stringify(it))
        existed ? updated++ : inserted++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return { inserted, updated }
  }

  /**
   * Tar bort poster som inte längre finns (t.ex. borttagna kalenderposter).
   *
   * `exceptKinds` undantas alltid: nyheter och planeringar är i praktiken
   * append-only, och ett tillfälligt ofullständigt svar får inte rensa dem (då
   * blir allt "nytt" igen nästa tick — och för planeringar betyder det larm).
   */
  pruneMissing(keepKeys, { exceptKinds = [] } = {}) {
    const keep = new Set(keepKeys)
    const except = new Set(exceptKinds)
    const rows = this.db.prepare('SELECT key, kind FROM items').all()
    const del = this.db.prepare('DELETE FROM items WHERE key = ?')
    let removed = 0
    this.db.exec('BEGIN')
    try {
      for (const r of rows) {
        if (keep.has(r.key) || except.has(r.kind)) continue
        del.run(r.key)
        removed++
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return removed
  }

  /**
   * Kända planeringsdetaljer: id → {at, info}. Gather hämtar detaljen bara när
   * den är ny, äldre än ett dygn eller aviserad som ändrad — detaljen kostar ett
   * anrop per planering. Planeringar gallras aldrig bort (exceptKinds i
   * pruneMissing), så en planering från ett tidigare läsår blir inte "ny" igen.
   */
  planDetails() {
    const out = new Map()
    for (const item of this.getPrevIndex().values()) {
      if (item.kind !== 'plan' || !item.id) continue
      const { start, end, teachers, term, grade, fields, description, assignments, fetchedAt } = item
      out.set(String(item.id), {
        at: fetchedAt ?? 0,
        info: { start, end, teachers, term, grade, fields, description, assignments },
      })
    }
    return out
  }

  /** Loggar händelser i den append-only historiken. */
  logEvents(events, now = new Date().toISOString()) {
    const ins = this.db.prepare(`
      INSERT INTO events (ts, type, kind, child, item_key, title, priority, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const ids = []
    this.db.exec('BEGIN')
    try {
      for (const e of events) {
        const info = ins.run(now, e.type, e.kind, e.child ?? null, e.key ?? null, e.title ?? null, e.priority ?? 'digest', JSON.stringify(e))
        ids.push(Number(info.lastInsertRowid))
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return ids
  }

  /**
   * Händelser som ännu inte levererats, äldst först.
   *
   * OBS: händelsedata innehåller ofta ett eget `id` (t.ex. notisens id). Det får
   * inte skriva över databasradens id — därför exponeras rad-id:t som `rowId`
   * och används för markDelivered. (Buggen som gav upprepade mejl.)
   */
  pendingEvents({ priority } = {}) {
    const sql = priority
      ? 'SELECT * FROM events WHERE delivered_at IS NULL AND priority = ? ORDER BY id'
      : 'SELECT * FROM events WHERE delivered_at IS NULL ORDER BY id'
    const rows = priority ? this.db.prepare(sql).all(priority) : this.db.prepare(sql).all()
    return rows.map((r) => ({ ...JSON.parse(r.data), rowId: r.id, ts: r.ts }))
  }

  /** Markerar händelser som levererade. */
  markDelivered(ids, now = new Date().toISOString()) {
    if (!ids.length) return 0
    const upd = this.db.prepare('UPDATE events SET delivered_at = ? WHERE id = ?')
    this.db.exec('BEGIN')
    try {
      for (const id of ids) upd.run(now, id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return ids.length
  }

  /** Fritextsök i händelsehistoriken (titel). */
  search(text, limit = 50) {
    const like = `%${text}%`
    return this.db
      .prepare('SELECT id, ts, type, child, title FROM events WHERE title LIKE ? ORDER BY id DESC LIMIT ?')
      .all(like, limit)
  }

  /** Alla händelser för ett barn under ett intervall (ISO-datum). */
  historyForChild(child, fromISO, toISO, limit = 500) {
    return this.db
      .prepare('SELECT id, ts, type, title FROM events WHERE child = ? AND ts >= ? AND ts <= ? ORDER BY id DESC LIMIT ?')
      .all(child, `${fromISO}T00:00:00`, `${toISO}T23:59:59.999`, limit)
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? row.value : null
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value))
  }
}
