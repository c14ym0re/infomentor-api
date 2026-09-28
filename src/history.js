// Historik & sök i händelsearkivet.
//   node src/history.js status
//   node src/history.js search <text>
//   node src/history.js child "<hub-namn>" [från-ISO] [till-ISO]
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = process.env.INFOMENTOR_DB || join(root, 'out', 'infomentor.db')

if (!existsSync(dbPath) && process.argv[2] !== 'status') {
  console.error(`Inget arkiv ännu (${dbPath}). Kör pollaren först.`)
  process.exit(1)
}

const store = new Store(dbPath)
const [cmd, ...args] = process.argv.slice(2)

switch (cmd) {
  case 'search': {
    const q = args.join(' ')
    if (!q) {
      console.error('Användning: node src/history.js search <text>')
      process.exit(2)
    }
    const rows = store.search(q)
    console.log(`${rows.length} träff(ar) på "${q}":`)
    for (const r of rows) console.log(`  ${r.ts.slice(0, 10)}  [${r.type}]  ${r.child ?? 'Alla'}  ${r.title}`)
    break
  }
  case 'child': {
    const [child, from = '1970-01-01', to = '2999-12-31'] = args
    if (!child) {
      console.error('Användning: node src/history.js child "<hub-namn>" [från] [till]')
      process.exit(2)
    }
    const rows = store.historyForChild(child, from, to)
    console.log(`${rows.length} händelse(r) för ${child} (${from} → ${to}):`)
    for (const r of rows) console.log(`  ${r.ts.slice(0, 10)}  [${r.type}]  ${r.title}`)
    break
  }
  case 'status':
  default: {
    const total = store.db.prepare('SELECT COUNT(*) c FROM events').get().c
    const items = store.db.prepare('SELECT COUNT(*) c FROM items').get().c
    const pending = store.db.prepare('SELECT COUNT(*) c FROM events WHERE delivered_at IS NULL').get().c
    const byKind = store.db.prepare('SELECT kind, COUNT(*) c FROM items GROUP BY kind ORDER BY c DESC').all()
    const lastPoll = store.getMeta('lastPoll')
    console.log(`Databas: ${dbPath}`)
    console.log(`Senaste poll: ${lastPoll ?? '(aldrig)'}`)
    console.log(`Aktuella poster: ${items}  ·  händelser i historiken: ${total}  ·  olevererade: ${pending}`)
    console.log('Per typ:')
    for (const r of byKind) console.log(`  ${r.kind.padEnd(14)} ${r.c}`)
    break
  }
}

store.close()
