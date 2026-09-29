// Sätter integrationens options via HAs REST-API för options-flödet
// (samma väg som UI:t använder).
//   node src/set-options.js
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHaEnv } from './ha-api.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = existsSync(join(root, 'config.json'))
  ? JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
  : {}

// Standardvärden för ett generiskt exempel — egna värden sätts i den
// gitignorerade config.json under "integrationOptions".
const USER_INPUT = config.integrationOptions ?? {
  scan_interval: 20,
  enable_lunch: false,
  mateo_unit_id: '',
  names: '', // en rad per barn: "Efternamn, Förnamn = Smeknamn"
}

const { url, token } = readHaEnv(config.ha?.envFile)
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

async function api(path, options = {}) {
  const res = await fetch(`${url}/api${path}`, { headers, ...options })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// 1. Hitta config-posten
const entries = await api('/config/config_entries/entry')
const entry = (Array.isArray(entries) ? entries : []).find((e) => e.domain === 'infomentor')
if (!entry) {
  console.error('❌ hittar ingen infomentor-config-entry')
  process.exit(1)
}
console.log(`Config entry: ${entry.title} (${entry.entry_id})`)

// 2. Starta options-flödet
const flow = await api('/config/config_entries/options/flow', {
  method: 'POST',
  body: JSON.stringify({ handler: entry.entry_id }),
})
if (!flow?.flow_id) {
  console.error(`❌ kunde inte starta options-flödet: ${JSON.stringify(flow)}`)
  process.exit(1)
}
console.log(`Options-flöde startat: ${flow.flow_id}`)

// 3. Skicka in värdena
const result = await api(`/config/config_entries/options/flow/${flow.flow_id}`, {
  method: 'POST',
  body: JSON.stringify(USER_INPUT),
})

if (result?.type !== 'create_entry') {
  console.error(`❌ flödet skapade ingen post: ${JSON.stringify(result).slice(0, 400)}`)
  process.exit(1)
}
console.log('✅ Options sparade:')
for (const [key, value] of Object.entries(result.data ?? USER_INPUT)) {
  console.log(`   ${key}: ${String(value).replace(/\n/g, ' | ')}`)
}
