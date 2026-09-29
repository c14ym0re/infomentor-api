// Pollare + notismotor. Körs som enskilda tick (cron) eller som loop.
//
//   node src/watch.js --once     # ett tick (för cron, t.ex. var 20:e minut)
//   node src/watch.js --digest   # tvinga kvällssammanställning nu
//   node src/watch.js            # loopa med pollMinutes-intervall
//   lägg till --dry              # inga mejl/MQTT (test)
//
// Ett tick: samla in → uppdatera arkivet → publicera HA → akuta notiser
// (utanför tysta timmar) → kvällsdigest när klockan passerat digestAt.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
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
import { buildDigest, formatEventLines } from './digest.js'
import { discoveryMessages, stateMessages } from './ha.js'
import { publishViaHa, readHaEnv, messagesHash } from './ha-api.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })

const DEFAULTS = {
  pollMinutes: 20,
  digestAt: '18:00',
  quietHours: { from: '20:30', to: '06:30' },
  db: join(outDir, 'infomentor.db'),
  mqtt: { enabled: true, discoveryPrefix: 'homeassistant' },
}
const cfgPath = join(root, 'config.json')
const config = { ...DEFAULTS, ...(existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {}) }
if (!config.db) config.db = DEFAULTS.db

const argv = process.argv.slice(2)
const args = new Set(argv)
const DRY = args.has('--dry')
const ONCE = args.has('--once')
const FORCE_DIGEST = args.has('--digest')
const NO_DIGEST = args.has('--no-digest')

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}
export function isQuiet(quiet, now = new Date()) {
  const cur = now.getHours() * 60 + now.getMinutes()
  const from = minutesOf(quiet.from)
  const to = minutesOf(quiet.to)
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to
}

function run(cmd, cmdArgs, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { cwd: root, env: { ...process.env, ...env } })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}\n${out}`))))
  })
}

async function publishHa(store, snapshot) {
  if (!config.mqtt?.enabled) return
  let ha
  try {
    ha = readHaEnv(config.ha?.envFile)
  } catch (err) {
    log(`MQTT: hoppar över (${err.message})`)
    return
  }
  const discovery = discoveryMessages(snapshot, { discoveryPrefix: config.mqtt.discoveryPrefix || 'homeassistant' })
  const hash = messagesHash(discovery)
  const messages = [...(hash !== store.getMeta('discoveryHash') ? discovery : []), ...stateMessages(snapshot)]
  if (DRY) {
    log(`MQTT (dry): ${messages.length} meddelanden`)
    return
  }
  const sent = await publishViaHa(messages, { url: ha.url, token: ha.token })
  store.setMeta('discoveryHash', hash)
  store.setMeta('lastPublish', new Date().toISOString())
  log(`MQTT: ${sent} meddelanden via HA`)
}

async function sendEmail(store, { subject, bodyFile, htmlFile, noHtml, events }) {
  if (DRY) {
    log(`Mejl (dry): "${subject}"`)
    return true
  }
  const env = { MAIL_SUBJECT: subject, MAIL_BODY_FILE: bodyFile }
  if (htmlFile) env.MAIL_HTML_FILE = htmlFile
  if (noHtml) env.MAIL_NO_HTML = '1'
  try {
    const out = await run('python3', ['src/send_mail.py'], env)
    log(out.trim().split('\n').pop())
    return true
  } catch (err) {
    log(`Mejl misslyckades: ${err.message}`)
    return false
  }
}

async function tick({ forceDigest = false } = {}) {
  const store = new Store(config.db)
  try {
    const initialized = store.getMeta('initialized') === '1'
    // Posttyper som redan fått sin baslinje (se seedNewKinds).
    const seeded = store.seededKinds()
    const snapshot = await gather({
      log: (m) => log(`gather: ${m}`),
      // Planeringsdetaljen är ett anrop per planering: hämta den bara när
      // planeringar är en känd typ (annars vore hela listan "ny").
      knownPlans: initialized && seeded.has('plan') ? store.planDetails() : null,
    })
    writeFileSync(join(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2))

    const prevIndex = store.getPrevIndex()
    const items = itemsFromSnapshot(snapshot)
    const todayIso = new Date().toISOString().slice(0, 10)
    let events = initialized ? detectChanges(prevIndex, items, { today: todayIso }) : []
    // En ny posttyp (t.ex. planeringar) får en baslinje i stället för att larma
    // för hela sin historik; första gången en planerings detalj hämtas är ingen
    // ändring; och en planering aviseras en gång — inte både som notis och som
    // plan-händelse.
    const seededNow = seedNewKinds(events, items, seeded)
    events = dropEnrichmentChanges(dedupePlanNotifications(seededNow.events), prevIndex)
    for (const e of events) {
      if (e.type === 'plan.changed') e.changedFields = planChanges(prevIndex.get(e.key) ?? {}, e)
    }
    store.setMeta('seededKinds', [...seededNow.seeded].join(','))

    store.applyItems(items)
    // Nyheter och planeringar är append-only och gallras aldrig (exceptKinds).
    store.pruneMissing(
      items.map((i) => i.key),
      { exceptKinds: ['news', 'plan'] }
    )
    if (events.length) store.logEvents(events)
    store.setMeta('initialized', '1')
    store.setMeta('lastPoll', snapshot.collectedAt)
    log(`insamlat: ${items.length} poster, ${events.length} nya händelser`)

    await publishHa(store, snapshot)

    // Akuta notiser (utanför tysta timmar).
    const immediate = store.pendingEvents({ priority: 'immediate' })
    if (immediate.length && !isQuiet(config.quietHours)) {
      const body = ['Nya händelser i Infomentor:', '', ...formatEventLines(immediate)].join('\n')
      const bodyFile = join(outDir, 'alert.txt')
      writeFileSync(bodyFile, body)
      const ok = await sendEmail(store, {
        subject: `Infomentor ⚠️ — ${immediate.length} ny(a) händelse(r)`,
        bodyFile,
        noHtml: true,
      })
      if (ok && !DRY) store.markDelivered(immediate.map((e) => e.rowId))
    } else if (immediate.length) {
      log(`${immediate.length} akuta händelser sparas till kvällsdigest (tysta timmar)`)
    }

    // Kvällsdigest när klockan passerat digestAt.
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const due = minutesOf(`${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`) >= minutesOf(config.digestAt)
    const already = store.getMeta('digestDate') === today
    const wantDigest = !NO_DIGEST && (forceDigest || (due && !already))
    if (wantDigest && !DRY) {
      await run(process.execPath, ['src/report.js'])
    }
    if (wantDigest) {
      const pending = store.pendingEvents()
      const digest = buildDigest(snapshot, { events: initialized ? pending : null })
      writeFileSync(join(outDir, 'digest.txt'), digest)
      const ok = await sendEmail(store, {
        subject: digest.split('\n')[0],
        bodyFile: join(outDir, 'digest.txt'),
        htmlFile: join(outDir, 'kvallssammanfattning.html'),
      })
      if (ok && !DRY) {
        store.markDelivered(pending.map((e) => e.rowId))
        store.setMeta('digestDate', today)
      }
    }
  } finally {
    store.close()
  }
}

async function main() {
  if (FORCE_DIGEST || ONCE) {
    await tick({ forceDigest: FORCE_DIGEST })
    return
  }
  log(`watch startar — var ${config.pollMinutes}:e minut, digest ${config.digestAt}`)
  for (;;) {
    try {
      await tick()
    } catch (err) {
      log(`tick misslyckades: ${err.message}`)
    }
    await new Promise((r) => setTimeout(r, config.pollMinutes * 60_000))
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`)
  process.exit(1)
})
