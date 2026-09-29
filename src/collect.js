// Manuell insamling + sammanställning (debug/engångskörning).
// Orkestreringen sköts av watch.js; den här finns för att inspektera läget.
//   node src/collect.js
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gather } from './gather.js'
import { Store } from './store.js'
import { itemsFromSnapshot, detectChanges } from './events.js'
import { buildDigest } from './digest.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
const dbPath = process.env.INFOMENTOR_DB || join(outDir, 'infomentor.db')

const snapshot = await gather({ log: (m) => console.log(`[gather] ${m}`) })
writeFileSync(join(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2))

// Uppdatera arkivet och logga händelser.
const store = new Store(dbPath)
const initialized = store.getMeta('initialized') === '1'
const items = itemsFromSnapshot(snapshot)
const today = new Date().toISOString().slice(0, 10)
const events = initialized ? detectChanges(store.getPrevIndex(), items, { today }) : []
store.applyItems(items)
store.pruneMissing(items.filter((i) => i.kind !== 'news').map((i) => i.key))
if (events.length) store.logEvents(events)
store.setMeta('initialized', '1')
store.setMeta('lastPoll', snapshot.collectedAt)

const digest = buildDigest(snapshot, { events: initialized ? events : null })
store.close()

writeFileSync(join(outDir, 'digest.txt'), digest)
console.log('\n' + digest)
console.log(`\n(arkivet: ${items.length} poster, ${events.length} nya händelser)`)
