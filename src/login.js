// Steg 1: verifiera att kontoinloggningen ger en levande hub-session.
//   node src/login.js
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login } from './infomentor.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function readCreds() {
  const p = join(root, 'credentials.json')
  try {
    const c = JSON.parse(readFileSync(p, 'utf8'))
    const username = c.username || c.email
    if (!username || !c.password) throw new Error('username/email och password krävs')
    return { username, password: c.password }
  } catch (err) {
    console.error(`Kunde inte läsa ${p}: ${err.message}`)
    console.error('Kopiera credentials.json.example → credentials.json och fyll i.')
    process.exit(1)
  }
}

const creds = readCreds()
console.log(`Loggar in som ${creds.username} (lösenord ${'*'.repeat(creds.password.length)})`)

const { jar, hubRootHtml } = await login(creds)

console.log('\nCookies i jar:', jar.names().join(', ') || '(inga)')
const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'jar.json'), JSON.stringify(jar.toJSON(), null, 2))
writeFileSync(join(outDir, 'hub-root.html'), hubRootHtml)
console.log(`Session-cookies sparade i out/jar.json, hub-HTML i out/hub-root.html`)
