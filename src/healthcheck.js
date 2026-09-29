// Veckokoll: pollarens hälsa + InfoMentor-relaterade varningar i HA-loggen.
//   node src/healthcheck.js          # skriv ut rapporten
//   node src/healthcheck.js --mail   # mejla rapporten till adminEmail
//   node src/healthcheck.js --dry    # skriv inte till loggfil/mejla
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'
import { readHaEnv } from './ha-api.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
const MAIL = args.has('--mail')

const configPath = join(root, 'config.json')
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
const dbPath = process.env.INFOMENTOR_DB || config.db || join(outDir, 'infomentor.db')
const pollMinutes = Number(config.pollMinutes || 20)
const adminEmail = config.adminEmail

const ANSI = /\u001b\[[0-9;]*m/g

function run(cmd, cmdArgs) {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(cmd, cmdArgs, { env: process.env })
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (err) => resolve({ code: -1, out: String(err) }))
    child.on('close', (code) => resolve({ code, out }))
  })
}

const findings = []
const notes = []

function flag(msg) {
  findings.push(msg)
}

// ---------------------------------------------------------------- pollaren
let stats = { items: 0, events: 0, pending: 0, lastPoll: null }
if (existsSync(dbPath)) {
  const store = new Store(dbPath)
  try {
    stats.items = store.db.prepare('SELECT COUNT(*) c FROM items').get().c
    stats.events = store.db.prepare('SELECT COUNT(*) c FROM events').get().c
    stats.pending = store.pendingEvents().length
    stats.lastPoll = store.getMeta('lastPoll')
  } finally {
    store.close()
  }
  if (!stats.lastPoll) {
    flag('pollaren har aldrig kört (ingen lastPoll i arkivet)')
  } else {
    const ageMin = Math.round((Date.now() - Date.parse(stats.lastPoll)) / 60000)
    if (ageMin > pollMinutes * 2 + 5) flag(`senaste insamlingen var för ${ageMin} min sedan (> 2×intervallet)`)
    else notes.push(`senaste insamling: för ${ageMin} min sedan ✓`)
  }
} else {
  flag(`hittar inget arkiv (${dbPath})`)
}

// watch.log – räknade varningar i slutet
const watchLog = join(outDir, 'watch.log')
if (existsSync(watchLog)) {
  const lines = readFileSync(watchLog, 'utf8').split('\n').slice(-500)
  const warns = lines.filter((l) => /VARNING|misslyckades|FATAL/i.test(l)).length
  if (warns) flag(`watch.log: ${warns} varning(ar) i senaste 500 raderna`)
  else notes.push('watch.log: inga varningar ✓')
}

// ---------------------------------------------------------------- HA-loggen
let haChecked = false
try {
  const { url } = readHaEnv(config.ha?.envFile)
  const host = new URL(url).hostname
  const res = await run('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    `root@${host}`,
    'ha core logs',
  ])
  if (res.code !== 0) {
    notes.push(`kunde inte läsa HA-loggen (ssh exit ${res.code}) — hoppar över`)
  } else {
    haChecked = true
    const relevant = res.out
      .replace(ANSI, '')
      .split('\n')
      .filter((l) => /infomentor/i.test(l))
      .filter((l) => /warning|error|critical|traceback/i.test(l))
      .filter((l) => !/not been tested by Home Assistant/i.test(l)) // alltid närvarande, ofarlig
    const seen = new Map()
    for (const line of relevant) {
      const msg = line.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\s*/, '').trim()
      seen.set(msg, (seen.get(msg) || 0) + 1)
    }
    for (const [msg, count] of seen) flag(`HA-logg: ${msg}${count > 1 ? ` (x${count})` : ''}`)
  }
} catch (err) {
  notes.push(`kunde inte läsa HA-loggen: ${err.message}`)
}

// ---------------------------------------------------------------- rapport
const now = new Date()
const lines = []
lines.push(`Infomentor veckokoll — ${now.toLocaleString('sv-SE')}`)
lines.push('')
lines.push('Poller')
lines.push(`  arkiv: ${stats.items} poster, ${stats.events} händelser, ${stats.pending} olevererade`)
for (const n of notes) lines.push(`  ${n}`)
lines.push('')
lines.push(`HA-logg (${haChecked ? 'läst' : 'ej läst'})`)
if (findings.some((f) => f.startsWith('HA-logg'))) {
  for (const f of findings.filter((f) => f.startsWith('HA-logg'))) lines.push(`  ⚠️ ${f}`)
} else if (haChecked) {
  lines.push('  inga InfoMentor-varningar eller -fel ✓')
}
lines.push('')
const problems = findings.length
lines.push(problems ? `Slutsats: ${problems} sak(er) att titta på.` : 'Slutsats: allt ser bra ut ✅')

const report = lines.join('\n')
console.log(report)

if (DRY) process.exit(0)

writeFileSync(join(outDir, 'health.txt'), report)
appendFileSync(join(outDir, 'health.log'), `\n=== ${now.toISOString()} (${problems} problem) ===\n${report}\n`)

if (MAIL) {
  if (!adminEmail) {
    console.error('Ingen adminEmail i config.json — kan inte mejla.')
    process.exit(0)
  }
  const env = {
    ...process.env,
    MAIL_TO: adminEmail,
    MAIL_SUBJECT: problems
      ? `Infomentor veckokoll ⚠️ — ${problems} sak(er) att titta på`
      : 'Infomentor veckokoll ✅ — allt väl',
    MAIL_BODY_FILE: join(outDir, 'health.txt'),
    MAIL_NO_HTML: '1',
  }
  const res = await new Promise((resolve) => {
    let out = ''
    const child = spawn('python3', ['src/send_mail.py'], { cwd: root, env })
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
  })
  console.log(res.out.trim().split('\n').pop())
  if (res.code !== 0) process.exitCode = 1
}
