// Publicerar HA-sensorer (MQTT Discovery + tillstånd) via HA:s mqtt.publish.
//   node src/publish-ha.js --dry   # visa bara vad som skulle skickas
//   node src/publish-ha.js         # publicera
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'
import { discoveryMessages, stateMessages } from './ha.js'
import { publishViaHa, readHaEnv, messagesHash } from './ha-api.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
const snapshotPath = join(outDir, 'snapshot.json')
const configPath = join(root, 'config.json')

if (!existsSync(snapshotPath)) {
  console.error('out/snapshot.json saknas — kör `npm run collect` först.')
  process.exit(1)
}
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
const discoveryPrefix = config.mqtt?.discoveryPrefix || 'homeassistant'
const dbPath = process.env.INFOMENTOR_DB || join(outDir, 'infomentor.db')

const discovery = discoveryMessages(snapshot, { discoveryPrefix })
const states = stateMessages(snapshot)

// --purge: publicera tomma retained-meddelanden så HA tar bort entiteterna.
// Används när man går över till HACS-integrationen och vill slippa dubbletter.
if (process.argv.includes('--purge')) {
  const store = new Store(dbPath)
  const purgeMessages = [...discovery, ...states].map((m) => ({
    topic: m.topic,
    payload: '',
    retain: true,
  }))
  const ha = readHaEnv(config.ha?.envFile)
  try {
    const sent = await publishViaHa(purgeMessages, { url: ha.url, token: ha.token })
    store.setMeta('discoveryHash', '')
    console.log(`🧹 Rensade ${sent} MQTT-teman (retainade, tomma) — HA tar bort entiteterna.`)
  } catch (err) {
    console.error(`❌ ${err.message}`)
    process.exitCode = 1
  } finally {
    store.close()
  }
  process.exit(process.exitCode ?? 0)
}

const store = new Store(dbPath)
const hash = messagesHash(discovery)
const prevHash = store.getMeta('discoveryHash')
const needDiscovery = hash !== prevHash

const messages = [...(needDiscovery ? discovery : []), ...states]

console.log(`Discovery: ${discovery.length} enheter (${needDiscovery ? 'publiceras' : 'oförändrade, hoppas över'})`)
console.log(`Tillstånd: ${states.length} meddelanden`)
for (const e of discovery) console.log(`  · ${e.topic}`)

if (process.argv.includes('--dry')) {
  console.log('\n(--dry: inget publicerat)')
  store.close()
  process.exit(0)
}

const ha = readHaEnv(config.ha?.envFile)
try {
  const sent = await publishViaHa(messages, { url: ha.url, token: ha.token })
  store.setMeta('discoveryHash', hash)
  store.setMeta('lastPublish', new Date().toISOString())
  console.log(`\n✅ ${sent} MQTT-meddelanden publicerade via HA.`)
} catch (err) {
  console.error(`❌ ${err.message}`)
  process.exitCode = 1
} finally {
  store.close()
}
