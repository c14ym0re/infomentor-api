// Lägger in/uppdaterar skolpanelen i Home Assistant via HAs WebSocket-API
// (samma väg som UI:t använder — ingen handredigering av .storage).
//
//   node src/install-dashboard.js            # läser skolpanel-mitt.json
//   node src/install-dashboard.js --dry
//   DASHBOARD_FILE=annan.json node src/install-dashboard.js
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHaEnv, expandHome } from './ha-api.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = existsSync(join(root, 'config.json'))
  ? JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
  : {}

const filePath = expandHome(
  process.env.DASHBOARD_FILE || config.ha?.dashboardFile || join(root, 'dashboard.json')
)
if (!existsSync(filePath)) {
  console.error(`Saknar ${filePath}`)
  process.exit(1)
}
const DASHBOARD = JSON.parse(readFileSync(filePath, 'utf8'))
const view = DASHBOARD.views?.[0] ?? {}
const URL_PATH = process.env.DASHBOARD_URL_PATH || 'skol-panel'
const TITLE = view.title || 'Skola'
const DRY = process.argv.includes('--dry')

const cardCount = (view.sections ?? view.cards ?? []).reduce(
  (sum, item) => sum + (item.cards ? item.cards.length : 1),
  0
)

if (DRY) {
  console.log(`[dry] "${TITLE}" (/${URL_PATH}) — ${view.type}-vy, ${cardCount} kort`)
  process.exit(0)
}

const { url, token } = readHaEnv(config.ha?.envFile)
const ws = new WebSocket(url.replace(/^http/, 'ws') + '/api/websocket')

let nextId = 1
const pending = new Map()
const call = (type, payload = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, type, ...payload }))
  })

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.type === 'auth_required') {
    ws.send(JSON.stringify({ type: 'auth', access_token: token }))
    return
  }
  if (msg.type === 'auth_ok') {
    run().catch(fail)
    return
  }
  if (msg.type === 'auth_invalid') return fail(new Error(msg.message))
  if (typeof msg.id === 'number' && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.success ? resolve(msg.result) : reject(new Error(JSON.stringify(msg.error)))
  }
})
ws.addEventListener('error', () => fail(new Error('WebSocket-fel')))

function fail(err) {
  console.error(`❌ ${err.message}`)
  try {
    ws.close()
  } catch {}
  process.exit(1)
}

async function run() {
  const dashboards = await call('lovelace/dashboards/list')
  const existing = dashboards.find((d) => d.url_path === URL_PATH)
  if (existing) {
    console.log(`Instrumentpanelen "/${URL_PATH}" finns — uppdaterar.`)
  } else {
    await call('lovelace/dashboards/create', {
      url_path: URL_PATH,
      title: TITLE,
      icon: view.icon || 'mdi:school',
      show_in_sidebar: true,
      require_admin: false,
    })
    console.log(`✅ Skapade "${TITLE}" (/${URL_PATH}).`)
  }
  await call('lovelace/config/save', { url_path: URL_PATH, config: DASHBOARD })
  const saved = await call('lovelace/config', { url_path: URL_PATH })
  const sections = saved.views?.[0]?.sections?.length ?? 0
  console.log(`✅ Sparad: ${sections ? `${sections} sektioner` : `${saved.views?.[0]?.cards?.length ?? 0} kort`}.`)
  console.log(`Öppna: ${url}/${URL_PATH}`)
  ws.close()
  process.exit(0)
}
