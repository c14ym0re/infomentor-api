// Manuell insamling + sammanställning (debug/engångskörning).
// Orkestreringen sköts av watch.js; den här finns för att inspektera läget.
//   node src/collect.js
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gather } from './gather.js'
import { Store } from './store.js'
import {
  itemsFromSnapshot,
  detectChanges,
  dedupePlanNotifications,
  dropEnrichmentChanges,
  seedNewKinds,
} from './events.js'
import { planChanges } from './plans.js'
import { buildDigest } from './digest.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
const dbPath = process.env.INFOMENTOR_DB || join(outDir, 'infomentor.db')

// Uppdatera arkivet och logga händelser.
const store = new Store(dbPath)
const initialized = store.getMeta('initialized') === '1'
const seeded = store.seededKinds()

const snapshot = await gather({
  log: (m) => console.log(`[gather] ${m}`),
  knownPlans: initialized && seeded.has('plan') ? store.planDetails() : null,
})
writeFileSync(join(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2))

const prevIndex = store.getPrevIndex()
const items = itemsFromSnapshot(snapshot)
const today = new Date().toISOString().slice(0, 10)
let events = initialized ? detectChanges(prevIndex, items, { today }) : []
const seededNow = seedNewKinds(events, items, seeded)
events = dropEnrichmentChanges(dedupePlanNotifications(seededNow.events), prevIndex)
for (const e of events) {
  if (e.type === 'plan.changed') e.changedFields = planChanges(prevIndex.get(e.key) ?? {}, e)
}
store.setMeta('seededKinds', [...seededNow.seeded].join(','))
store.applyItems(items)
store.pruneMissing(items.map((i) => i.key), { exceptKinds: ['news', 'plan'] })
if (events.length) store.logEvents(events)
store.setMeta('initialized', '1')
store.setMeta('lastPoll', snapshot.collectedAt)

const digest = buildDigest(snapshot, { events: initialized ? events : null })
store.close()

writeFileSync(join(outDir, 'digest.txt'), digest)
console.log('\n' + digest)
console.log(`\n(arkivet: ${items.length} poster, ${events.length} nya händelser)`)
