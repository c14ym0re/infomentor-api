// Bevakar GitHub-issues för våra repon och mejlar vid ny aktivitet.
//   node src/issuewatch.js            # diffa mot förra körningen, mejla vid nytt
//   node src/issuewatch.js --report   # mejla läget just nu (oavsett nytt)
//   node src/issuewatch.js --dry      # skriv bara ut
//
// Första körningen sätter en baslinje (mejlar inte om det som redan finns).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHome } from './ha-api.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
const statePath = join(outDir, 'issuewatch.json')
const reportPath = join(outDir, 'issues.txt')

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry')
const REPORT = args.has('--report')

const config = existsSync(join(root, 'config.json'))
  ? JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
  : {}
const adminEmail = config.adminEmail
const REPOS = config.github?.repos ?? [
  'c14ym0re/infomentor-homeassistant',
  'c14ym0re/infomentor-api',
]

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  const candidates = [
    process.env.GITHUB_CREDENTIALS,
    config.github?.credentialsFile,
    join(homedir(), '.config', 'infomentor', 'git-credentials'),
  ].filter(Boolean)
  for (const path of candidates) {
    const file = expandHome(path)
    if (!existsSync(file)) continue
    const m = readFileSync(file, 'utf8').match(/https:\/\/[^:]+:([^@]+)@github\.com/)
    if (m) return m[1]
  }
  throw new Error(
    `hittar ingen GitHub-token — sätt GITHUB_TOKEN eller config.github.credentialsFile (letade i ${candidates.join(', ')})`
  )
}
const TOKEN = token()

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'infomentor-issuewatch',
    },
  })
  if (!res.ok) throw new Error(`GitHub ${res.status} på ${path}: ${(await res.text()).slice(0, 160)}`)
  return res.json()
}

const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { seeded: false, issues: {}, comments: {}, forks: {} }
state.forks ??= {}

const fresh = existsSync(statePath)
const lines = []
const counts = { issues: 0, comments: 0, forks: 0 }

for (const repo of REPOS) {
  const issues = await gh(`/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=50`)
  for (const issue of issues) {
    if (issue.pull_request) continue // PR:er hoppas över
    const key = `${repo}#${issue.number}`
    const known = state.issues[key]

    // Nytt issue?
    if (!known && fresh) {
      counts.issues++
      lines.push(
        `NYTT ISSUE  ${repo}#${issue.number}`,
        `  ${issue.title}`,
        `  av ${issue.user.login} · ${issue.state} · ${issue.created_at}`,
        ...wrap(issue.body || '(ingen beskrivning)', 72).slice(0, 12).map((l) => `  ${l}`),
        `  ${issue.html_url}`,
        ''
      )
    }

    // Nya kommentarer?
    const comments = await gh(`/repos/${repo}/issues/${issue.number}/comments?per_page=100`)
    for (const c of comments) {
      const cid = String(c.id)
      if (!state.comments[cid] && fresh) {
        counts.comments++
        lines.push(
          `NY KOMMENTAR  ${repo}#${issue.number} — ${issue.title}`,
          `  av ${c.user.login} · ${c.created_at}`,
          ...wrap(c.body || '', 72).slice(0, 8).map((l) => `  ${l}`),
          `  ${c.html_url}`,
          ''
        )
      }
      state.comments[cid] = true
    }
    state.issues[key] = issue.updated_at
  }

  // Nya forks (t.ex. någon som speglar repot)
  const forks = await gh(`/repos/${repo}/forks?per_page=100&sort=newest`)
  for (const fork of forks) {
    if (!state.forks[fork.full_name] && fresh) {
      counts.forks++
      lines.push(
        `NY FORK  ${repo}`,
        `  ${fork.full_name} (skapad ${fork.created_at})`,
        `  ${fork.html_url}`,
        ''
      )
    }
    state.forks[fork.full_name] = fork.created_at
  }
}

state.seeded = true
state.lastRun = new Date().toISOString()

if (REPORT) {
  for (const repo of REPOS) {
    const open = await gh(`/repos/${repo}/issues?state=open&per_page=50`)
    lines.push(`${repo}: ${open.filter((i) => !i.pull_request).length} öppna issue(s)`)
    for (const i of open.filter((i) => !i.pull_request)) {
      lines.push(`  #${i.number} ${i.title}  (${i.user.login}, ${i.comments} kommentarer)`)
    }
  }
}

if (DRY) {
  console.log(lines.length ? lines.join('\n') : '(inget nytt)')
  process.exit(0)
}

writeFileSync(statePath, JSON.stringify(state, null, 2))

if (!lines.length) {
  console.log('Ingen ny GitHub-aktivitet.')
  process.exit(0)
}

const parts = []
if (counts.issues) parts.push(`${counts.issues} nytt issue`)
if (counts.comments) parts.push(`${counts.comments} ny kommentar`)
if (counts.forks) parts.push(`${counts.forks} ny fork`)
const subject = REPORT ? 'InfoMentor — öppna GitHub-issues' : `InfoMentor — ${parts.join(' + ')}`
const report = `InfoMentor — GitHub-aktivitet (${new Date().toLocaleString('sv-SE')})\n\n${lines.join('\n')}`
writeFileSync(reportPath, report)
console.log(report)

if (adminEmail) {
  const env = {
    ...process.env,
    MAIL_TO: adminEmail,
    MAIL_SUBJECT: subject,
    MAIL_BODY_FILE: reportPath,
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

function wrap(text, width) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ')
  const out = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      out.push(line.trim())
      line = w
    } else {
      line += ' ' + w
    }
  }
  if (line.trim()) out.push(line.trim())
  return out
}
