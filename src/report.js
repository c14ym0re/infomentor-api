// Genererar kvällssammanfattningen (HTML) från out/snapshot.json.
// E-postsäker: inline-stilar (Gmail tar bort <style>/<head>), tabeller för
// radjustering, WCAG 2.2 AA-kontrast och låst ljust läge.
//   node src/collect.js   (fyller på snapshot)
//   node src/report.js    (renderar rapporten)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { displayName } from './names.js'
import { planTopic } from './digest.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })

const snapPath = join(outDir, 'snapshot.json')
if (!existsSync(snapPath)) {
  console.error('out/snapshot.json saknas — kör `npm run collect` först.')
  process.exit(1)
}
const snap = JSON.parse(readFileSync(snapPath, 'utf8'))

// ---- design-tokens (Apple-inspirerade, kontrastsäkrade) --------------------
const FONT =
  "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"
const C = {
  ink: '#1d1d1f', // 16.8:1 på vitt
  ink2: '#515154', // 7.9:1 — sekundär, även små texter
  ink3: '#6e6e73', // 5.1:1 — dämpad meta
  line: '#e6e6e9',
  page: '#f5f5f7',
  card: '#ffffff',
  accent: '#0066cc', // 5.6:1
  red: '#b3261e',
  redBg: '#fff5f5',
  redLine: '#f3c9c5',
  amber: '#6b4e00',
  amberBg: '#fff8e6',
  amberLine: '#f0dca8',
  tagInk: '#0058a3',
  tagBg: '#eef5ff',
  lunchInk: '#1c5c34',
  lunchBg: '#f0faf3',
  lunchLine: '#c8e9d2',
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const isDone = (s) => /done|complete|klar/i.test(s || '')
const isPE = (t) => /\b(idh|idr|idrott|gymnastik|gympa)\b/i.test((t || '').trim())
const dayOf = (s) => String(s || '').slice(0, 10)
const timeOf = (s) => String(s || '').slice(11, 16)

const WD = ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör']
const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december']
const dateObj = (iso) => new Date(iso + 'T12:00:00')
const longDate = (iso) => {
  const d = dateObj(iso)
  return `${['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'][d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}
const shortDate = (iso) => {
  const d = dateObj(iso)
  return `${d.getDate()}/${d.getMonth() + 1}`
}
const dayShortLabel = (iso) => {
  const d = dateObj(iso)
  return `${WD[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`
}

const base = new Date(snap.collectedAt)
const at = (n) => {
  const d = new Date(base)
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const tomorrow = at(1)
const week = at(7)

// ---- idrottsflagga ---------------------------------------------------------
let peDay = null
for (let i = 1; i <= 8 && !peDay; i++) {
  const d = at(i)
  if (snap.events.some((e) => e.kind === 'Schema' && dayOf(e.start) === d)) peDay = d
}
const peLabel = peDay === tomorrow ? 'imorgon' : peDay ? dayShortLabel(peDay) : ''
const dayWord = peDay === tomorrow ? 'imorgon' : peDay ? dayShortLabel(peDay) : ''
const leadDate = longDate(peDay || tomorrow)
const peHits = []
if (peDay) {
  for (const p of snap.pupils) {
    const pe = snap.events
      .filter((e) => e.kind === 'Schema' && e.child === p.name && dayOf(e.start) === peDay && isPE(e.title))
      .sort((a, b) => a.start.localeCompare(b.start))
    if (pe.length) peHits.push({ name: displayName(p.name), times: pe.map((e) => timeOf(e.start)) })
  }
}

// ---- byggstenar ------------------------------------------------------------
const label = (text) =>
  `<h3 style="margin:24px 0 8px;font-family:${FONT};font-size:13px;line-height:18px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${C.ink2};">${esc(text)}</h3>`

const mutedRow = (text) =>
  `<p style="margin:0;font-family:${FONT};font-size:16px;line-height:22px;color:${C.ink3};">${esc(text)}</p>`

const tag = (t) =>
  `<span style="display:inline-block;font-family:${FONT};font-size:13px;line-height:18px;color:${C.tagInk};background-color:${C.tagBg};border-radius:6px;padding:1px 8px;margin-left:6px;white-space:nowrap;">${esc(t)}</span>`

const flagOverdue = () =>
  `<span style="display:inline-block;font-family:${FONT};font-size:12px;line-height:18px;font-weight:600;color:${C.red};background-color:${C.redBg};border:1px solid ${C.redLine};border-radius:6px;padding:1px 8px;margin-left:6px;white-space:nowrap;">Försenad</span>`

const metaText = (t) =>
  `<span style="color:${C.ink3};font-size:14px;"> · ${esc(t)}</span>`

/** Radtabell med hårfin avdelare — e-postsäker (tabell, inte flex). */
function rowsTable(rows) {
  if (!rows.length) return ''
  const body = rows
    .map((r, i) => {
      const bt = i === 0 ? 'none' : `1px solid ${C.line}`
      return (
        `<tr>` +
        `<td style="padding:9px 0;border-top:${bt};font-family:${FONT};font-size:16px;line-height:22px;color:${C.ink};font-weight:600;white-space:nowrap;vertical-align:top;font-variant-numeric:tabular-nums;">${r.left}</td>` +
        `<td style="padding:9px 0 9px 16px;border-top:${bt};font-family:${FONT};font-size:16px;line-height:22px;color:${C.ink};vertical-align:top;">${r.main}</td>` +
        `</tr>`
      )
    })
    .join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;">${body}</table>`
}

function box(inner, bg, line, ink) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;width:100%;"><tr><td style="background-color:${bg};border:1px solid ${line};border-radius:14px;padding:16px 18px;font-family:${FONT};font-size:16px;line-height:22px;color:${ink};">${inner}</td></tr></table>`
}

// ---- kort per barn ---------------------------------------------------------
const cards = snap.pupils
  .map((p) => {
    const name = p.name
    const show = displayName(name)
    const dayEvents = snap.events
      .filter((e) => e.kind === 'Schema' && e.child === name && peDay && dayOf(e.start) === peDay)
      .sort((a, b) => a.start.localeCompare(b.start))
    const first = dayEvents[0]
    // Max sluttid, inte sista posten i startordning (aktivitetsblock kan vara längre).
    const lastEnd = dayEvents.reduce(
      (max, item) => {
        const value = timeOf(item.end || item.start)
        return value > max ? value : max
      },
      ''
    )
    const schoolDayLine =
      dayEvents.length
        ? `<p style="margin:0;font-family:${FONT};font-size:19px;line-height:26px;font-weight:600;color:${C.ink};">${esc(
            timeOf(first.start)
          )}–${esc(lastEnd)}</p>`
        : mutedRow('Ingen skoldag.')
    const tasks = snap.tasks
      .filter((t) => t.child === name && !isDone(t.status) && t.due && dayOf(t.due) >= at(0) && dayOf(t.due) <= week)
      .sort((a, b) => a.due.localeCompare(b.due))
    const cal = snap.events
      .filter((e) => e.kind === 'Kalender' && e.child === name && dayOf(e.start) >= at(0) && dayOf(e.start) <= week)
      .sort((a, b) => a.start.localeCompare(b.start))
    const att = snap.absences.find((a) => a.child === name)

    const taskRows = tasks.length
      ? rowsTable(
          tasks.map((t) => {
            const topic = planTopic(t.plan, t.subject)
            return {
              left: esc(shortDate(dayOf(t.due))),
              main: `${esc(t.title)}${t.subject ? tag(t.subject) : ''}${
                topic ? `<span style="color:${C.ink3};font-size:14px;"> — ${esc(topic)}</span>` : ''
              }${t.overdue ? flagOverdue() : ''}`,
            }
          })
        )
      : mutedRow('Inga uppgifter att lämna in inom en vecka.')

    const calRows = cal.length
      ? rowsTable(
          cal.map((e) => ({
            left: esc(shortDate(dayOf(e.start))),
            main: `${esc(e.title)}${e.extra ? tag(e.extra) : ''}`,
          }))
        )
      : mutedRow('Inget inbokat.')

    const pe = peDay ? snap.events.filter((e) => e.kind === 'Schema' && e.child === name && dayOf(e.start) === peDay && isPE(e.title)) : []
    const peTag = pe.length
      ? `<span style="display:inline-block;font-family:${FONT};font-size:13px;line-height:18px;font-weight:600;color:${C.red};background-color:${C.redBg};border:1px solid ${C.redLine};border-radius:99px;padding:2px 10px;margin-left:8px;vertical-align:middle;white-space:nowrap;">🏃 idrottskläder</span>`
      : ''

    const parts = []
    if (att?.absentToday) parts.push('heldag idag')
    if (att?.absentTomorrow) parts.push('heldag imorgon')
    for (const s of att?.absentSessionsToday ?? []) parts.push(`idag: ${s}`)
    for (const s of att?.absentSessionsTomorrow ?? []) parts.push(`imorgon: ${s}`)
    if (att?.pendingLeaveRequests) parts.push(`${att.pendingLeaveRequests} ledighetsansökan`)
    const absence = parts.length ? box(`🕐 Frånvaro: ${esc(parts.join(', '))}`, C.amberBg, C.amberLine, C.amber) : ''

    return (
      `<tr><td style="background-color:${C.card};border:1px solid ${C.line};border-radius:18px;padding:24px;">` +
      `<h2 style="margin:0 0 2px;font-family:${FONT};font-size:20px;line-height:26px;font-weight:600;color:${C.ink};">${esc(show)}${peTag}</h2>` +
      label(`Skoldagen ${dayWord}`.trim()) +
      schoolDayLine +
      label('Uppgifter') +
      taskRows +
      label('Kalender (7 dagar)') +
      calRows +
      (absence ? `<div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>${absence}` : '') +
      `</td></tr>` +
      `<tr><td style="height:16px;line-height:16px;font-size:0;">&nbsp;</td></tr>`
    )
  })
  .join('')

// ---- ramverk ---------------------------------------------------------------
const totalTasks = snap.tasks.filter(
  (t) => !isDone(t.status) && t.due && dayOf(t.due) >= at(0) && dayOf(t.due) <= week
).length
const childNames = snap.pupils.map((p) => displayName(p.name)).join(', ')
const kidsLine = snap.pupils.map((p) => displayName(p.name)).join(' · ')

const peBanner = peHits.length
  ? box(
      `<div style="font-weight:600;font-size:17px;line-height:24px;">🏃 Idrott ${esc(peLabel)} — glöm inte idrottskläderna!</div>` +
        `<div style="margin-top:6px;font-size:15px;color:${C.ink2};">${peHits
          .map((h) => `${esc(h.name)} (${esc(h.times.join(', '))})`)
          .join(' · ')}</div>`,
      C.redBg,
      C.redLine,
      C.red
    ) +
    `<div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>`
  : ''

const lunch = peDay ? snap.lunch?.calendar?.[peDay] : null
const lunchBox = lunch?.length
  ? box(
      `<div style="font-weight:600;font-size:17px;line-height:24px;">🍽️ Skolmat ${esc(peLabel)}${
        snap.lunch.school ? ` — ${esc(snap.lunch.school)}` : ''
      }</div>` +
        lunch
          .map(
            (d) =>
              `<div style="margin-top:6px;font-size:16px;line-height:22px;"><span style="color:${C.lunchInk};opacity:.8;font-size:14px;">${esc(
                d.label || 'Lunch'
              )}:</span> ${esc(d.dish)}</div>`
          )
          .join(''),
      C.lunchBg,
      C.lunchLine,
      C.lunchInk
    ) +
    `<div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>`
  : ''

const preheader = `Imorgon: schema, uppgifter och påminnelser för ${childNames}`

const html = `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>Kvällskoll 🌙</title>
</head>
<body style="margin:0;padding:0;background-color:${C.page};color:${C.ink};color-scheme:light only;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:${C.page};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.page};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
    <tr><td style="padding:0 0 24px;">
      <h1 style="margin:0 0 6px;font-family:${FONT};font-size:28px;line-height:34px;font-weight:600;letter-spacing:-.02em;color:${C.ink};">Kvällskoll 🌙</h1>
      <p style="margin:0 0 4px;font-family:${FONT};font-size:17px;line-height:24px;color:${C.ink2};">Inför ${peDay === tomorrow ? 'imorgon' : 'skoldagen'}, ${esc(leadDate)}</p>
      <p style="margin:0;font-family:${FONT};font-size:14px;line-height:20px;color:${C.ink3};">${esc(kidsLine)} — ${totalTasks} uppgift(er) inom 7 dagar</p>
    </td></tr>
    ${peBanner ? `<tr><td>${peBanner}</td></tr>` : ''}
    ${lunchBox ? `<tr><td>${lunchBox}</td></tr>` : ''}
    ${cards}
    <tr><td style="padding:8px 0 0;text-align:center;font-family:${FONT};font-size:13px;line-height:18px;color:${C.ink3};">Hämtat från Infomentor</td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`

const outPath = join(outDir, 'kvallssammanfattning.html')
writeFileSync(outPath, html)
console.log(`Rapport skriven: ${outPath} (${Buffer.byteLength(html)} B)`)
