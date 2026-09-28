// Steg 2: logga in och kartlägg allt hubben svarar med.
//   node src/probe.js
//
// Skriver råsvar till out/*.json och skriver ut en sammanfattning.
// Fokus: (a) vad endpoints ger, (b) hur de tre barnen exponeras / växlas.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, hubPost } from './infomentor.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })

const creds = JSON.parse(readFileSync(join(root, 'credentials.json'), 'utf8'))
const username = creds.username || creds.email
if (!username || !creds.password) {
  console.error('credentials.json saknar username/email eller password')
  process.exit(1)
}

const { jar, hubRootHtml } = await login({ username, password: creds.password })
writeFileSync(join(outDir, 'hub-root.html'), hubRootHtml)

// ---------------------------------------------------------------- endpoints
const now = new Date()
const iso = (d) => d.toISOString().slice(0, 10)
const plusDays = (n) => {
  const d = new Date(now)
  d.setDate(d.getDate() + n)
  return d
}

const probes = [
  ['timetable-appData', '/timetable/timetable/appData', {
    startDate: iso(now),
    endDate: iso(plusDays(30)),
  }],
  ['news', '/Communication/News/GetNewsList', {}],
  ['notifications', '/NotificationApp/NotificationApp/GetNotifications', {}],
  ['notifications-appData', '/NotificationApp/NotificationApp/appData', {}],
  ['calendar', '/calendarv2/calendarv2/getentries', {
    startDate: iso(now),
    endDate: iso(plusDays(60)),
  }],
  ['classlist-appData', '/classlist/classlist/appData', {}],
  ['attendance-appData', '/attendance/attendance/appData', {}],
  ['documents', '/Communication/Documents/GetDocumentsList', {}],
  ['links', '/Communication/Links/GetLinksList', {}],
]

console.log('\n=== Probar hub-endpoints ===')
const summary = {}
for (const [name, path, body] of probes) {
  try {
    const r = await hubPost(jar, path, body)
    const len = r.text.length
    writeFileSync(join(outDir, `${name}.json`), r.text || '')
    const shape = describe(r.json, r.text)
    summary[name] = { status: r.status, bytes: len, shape }
    console.log(
      `  ${r.status}  ${String(len).padStart(7)} B  ${name.padEnd(22)} ${shape}`
    )
    if (len === 0) console.log(`        ⚠️  tom body = död/ogiltig session`)
  } catch (err) {
    console.log(`  ERR       ${name.padEnd(22)} ${err.message}`)
  }
}

// ------------------------------------------------------------- barnen
console.log('\n=== Elevspår i hub-HTML ===')
const pupilPatterns = [
  /selectedPupilName\s*:\s*'([^']*)'/g,
  /selectedPupilId\s*:\s*'?([^,'"}\s]+)'?/g,
  /pupilIM2Id\s*[:=]\s*'?([^,'"}\s]+)'?/g,
  /pupilSourceId\s*[:=]\s*'?([^,'"}\s]+)'?/g,
]
for (const re of pupilPatterns) {
  const hits = [...hubRootHtml.matchAll(re)].map((m) => m[1])
  if (hits.length) console.log(`  ${re.source.slice(0, 30)}… →`, [...new Set(hits)])
}

const pupilAll = [...hubRootHtml.matchAll(/[A-Za-z_"':,\s]{0,40}pupil[A-Za-z]{0,20}[A-Za-z_"':,\s]{0,40}/gi)]
  .map((m) => m[0].replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 10)
console.log('\n  Kontextsträngar med "pupil" (unika):')
for (const s of [...new Set(pupilAll)].slice(0, 25)) console.log(`    · ${s.slice(0, 140)}`)

const urls = [...hubRootHtml.matchAll(/["'](\/[^"']{2,80})["']/g)]
  .map((m) => m[1])
  .filter((u) => /pupil|child|select|switch|change|guardian|user/i.test(u))
console.log('\n  Kandidat-URL:er (pupil/child/select/switch):')
for (const u of [...new Set(urls)].slice(0, 25)) console.log(`    · ${u}`)

// notiser innehåller pupilIM2Id per notis — bra för att se om flera barn blandas
const notifFile = join(outDir, 'notifications.json')
try {
  const n = JSON.parse(readFileSync(notifFile, 'utf8'))
  const items = n.notifications || []
  const ids = new Set(items.map((i) => i.pupilIM2Id ?? i.pupilSourceId).filter(Boolean))
  console.log(`\n=== Notiser: ${items.length} st, ${ids.size} unika elev-ID ===`)
  console.log('  elev-ID:n:', [...ids])
  for (const i of items.slice(0, 8)) {
    console.log(`    · [${i.appType}] ${i.title} — ${i.subTitle || ''} (${i.dateSent || ''})`)
  }
} catch {
  /* ingen notisfil */
}

console.log(`\nRåsvar i ${outDir}/`)

function describe(json, text) {
  if (!text) return 'TOM'
  if (json === null) return `icke-JSON (${text.slice(0, 40).replace(/\s+/g, ' ')}…)`
  if (Array.isArray(json)) return `array[${json.length}]`
  if (typeof json === 'object') {
    const keys = Object.keys(json)
    const arr = keys.find((k) => Array.isArray(json[k]))
    return arr ? `{${keys.slice(0, 4).join(',')}…} ${arr}[${json[arr].length}]` : `{${keys.slice(0, 6).join(',')}}`
  }
  return typeof json
}
