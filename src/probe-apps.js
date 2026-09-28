// Probar övriga hub-appar (task/uolv2/assessmentv2/documentation/learnlog/…)
// för att hitta "Uppgifter" och planeringar.
//   node src/probe-apps.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, hubPost } from './infomentor.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
const creds = JSON.parse(readFileSync(join(root, 'credentials.json'), 'utf8'))

const { jar } = await login({
  username: creds.username || creds.email,
  password: creds.password,
})

const apps = [
  'task',
  'uolv2',
  'assessmentv2',
  'documentation',
  'learnlog',
  'meeting',
  'communication',
]

const candidates = []
for (const app of apps) {
  candidates.push([`${app}/appData`, `/${app}/${app}/appData`, {}])
  candidates.push([`${app}/appData(GET-ish)`, `/${app}/${app}/appData`, undefined])
}
// kända/plausibla actions
candidates.push(['task/GetTasks', '/task/task/GetTasks', {}])
candidates.push(['task/GetTaskList', '/task/task/GetTaskList', {}])
candidates.push(['task/getlist', '/task/task/getlist', {}])
candidates.push(['uolv2/GetUols', '/uolv2/uolv2/GetUols', {}])

for (const [name, path, body] of candidates) {
  try {
    const r = await hubPost(jar, path, body)
    const keys = r.json && typeof r.json === 'object' && !Array.isArray(r.json)
      ? Object.keys(r.json).slice(0, 8).join(',')
      : Array.isArray(r.json)
        ? `array[${r.json.length}]`
        : r.text.slice(0, 50).replace(/\s+/g, ' ')
    const mark = r.text.length > 40 ? '✅' : '  '
    console.log(`${mark} ${String(r.status)} ${String(r.text.length).padStart(6)}B  ${name.padEnd(22)} ${keys}`)
    if (r.text.length > 40) {
      writeFileSync(join(outDir, `${name.replace(/[^\w.-]/g, '_')}.json`), r.text)
    }
  } catch (e) {
    console.log(`   ERR       ${name.padEnd(22)} ${e.message}`)
  }
}
