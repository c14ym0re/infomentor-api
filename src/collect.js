// Pollare: logga in, samla in allt per barn, diffa mot förra körningen.
//   node src/collect.js
//
// Skriver:
//   out/snapshot.json  (senaste insamlade läget, för diff)
//   out/digest.txt     (sammanställningen — redo att skickas av t.ex. Hermes/HA)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, hubPost, follow, HUB } from './infomentor.js'
import { displayName } from './names.js'
import { fetchLunchCalendar, lunchConfig } from './lunch.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out')
mkdirSync(outDir, { recursive: true })

const creds = JSON.parse(readFileSync(join(root, 'credentials.json'), 'utf8'))
const iso = (d) => d.toISOString().slice(0, 10)
const plus = (n) => iso(new Date(Date.now() + n * 864e5))

// ---------------------------------------------------------------- samla in
const { jar } = await login({
  username: creds.username || creds.email,
  password: creds.password,
})

const pupils = await listPupils(jar)
const byPupilId = new Map(pupils.map((p) => [String(p.id), p.name]))

const notifications = ((await hubPost(jar, '/NotificationApp/NotificationApp/GetNotifications', {})).json
  ?.notifications ?? []).map((n) => ({
  id: String(n.id),
  appType: n.appType || '',
  type: n.type || '',
  title: n.title || '',
  subTitle: n.subTitle || '',
  date: n.dateSent || n.orderDate || '',
  url: n.url || '',
  child: childFromSourceId(n.pupilSourceId, byPupilId),
  state: n.state || '',
}))

const news = ((await hubPost(jar, '/Communication/News/GetNewsList', {})).json?.items ?? []).map((n) => ({
  id: String(n.id),
  title: n.title || '',
  published: n.publishedDate || '',
  by: n.publishedBy || '',
}))

const events = [] // per barn: kalender + schema
const tasks = [] // per barn: uppgifter (task/GetTasks)
const absences = []
for (const p of pupils) {
  await follow(jar, p.switchPupilUrl) // byt valt barn i sessionen

  const cal = (await hubPost(jar, '/calendarv2/calendarv2/getentries', {
    startDate: iso(new Date()),
    endDate: plus(30),
  })).json ?? []
  for (const c of Array.isArray(cal) ? cal : []) {
    // Kalenderposter som pekar på /task/show/ är uppgifter och listas separat
    // under "Uppgifter" — hoppa över dem här för att undvika dubbletter.
    if (/^\/task\/show\//.test(c.url || '')) continue
    events.push({
      key: `${p.name}|cal|${c.id}`,
      child: p.name,
      kind: 'Kalender',
      id: String(c.id),
      title: (c.title || '').trim(),
      start: c.startDateFull || c.startDate || '',
      end: c.endDateFull || c.endDate || '',
      allDay: !!c.isAllDayEvent,
      extra: (c.subjects || []).map((s) => s.title).filter(Boolean).join(', '),
      url: c.url || '',
    })
  }

  // gettimetablelist respekterar intervallet (till skillnad från appData som
  // alltid ger en rullande 5-dagarsvy) och inkluderar lunchrader.
  const ttRes = await hubPost(jar, '/timetable/timetable/gettimetablelist', {
    UTCOffset: '-120',
    start: iso(new Date()),
    end: plus(7),
  })
  const tt = Array.isArray(ttRes.json) ? ttRes.json : ttRes.json?.items ?? []
  for (const t of tt) {
    const title = (t.title || '').trim()
    if (isBreak(title)) continue
    events.push({
      key: `${p.name}|les|${t.start}|${title}`,
      child: p.name,
      kind: 'Schema',
      id: `${t.start}|${title}`,
      title,
      start: t.start || '',
      end: t.end || '',
      allDay: !!t.allDay,
      extra: t.notes?.roomInfo || '',
      url: '',
    })
  }

  const att = (await hubPost(jar, '/attendance/attendance/appData', {})).json ?? {}
  const absentSessions = (list) =>
    (list ?? []).filter((s) => s.isAbsent).map((s) => `${s.title} ${s.formattedTimeString}`)
  absences.push({
    child: p.name,
    absentToday: !!att.absentToday,
    absentTomorrow: !!att.absentTomorrow,
    absentSessionsToday: absentSessions(att.absenceTodaySessions),
    absentSessionsTomorrow: absentSessions(att.absenceTomorrowSessions),
    pendingLeaveRequests: (att.leaveRequests ?? []).length,
  })

  const taskRes = (await hubPost(jar, '/task/task/GetTasks', {})).json ?? {}
  for (const t of taskRes.items ?? []) {
    tasks.push({
      key: `${p.name}|task|${t.id}`,
      child: p.name,
      id: String(t.id),
      title: (t.title || '').trim(),
      subject: t.subject || '',
      due: t.dueDate || '',
      status: t.status || '',
      statusText: t.statusText || '',
      overdue: !!t.isOverdue,
      assigned: t.assignedOn || '',
      url: `/#/task/show/${t.id}`,
    })
  }
}

await restoreOriginalPupil(jar, pupils)

const lunchCfg = lunchConfig()
let lunchCalendar = {}
if (lunchCfg?.unitId) {
  try {
    lunchCalendar = await fetchLunchCalendar(iso(new Date()), plus(14))
  } catch (err) {
    console.warn(`[lunch] hämtning misslyckades: ${err.message}`)
  }
}

const snapshot = {
  collectedAt: new Date().toISOString(),
  pupils: pupils.map((p) => ({ id: String(p.id), name: p.name })),
  notifications,
  news,
  events,
  tasks,
  absences,
  lunch: lunchCfg
    ? { school: lunchCfg.school || '', unitId: lunchCfg.unitId, calendar: lunchCalendar }
    : null,
}
const prevPath = join(outDir, 'snapshot.json')
const prev = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, 'utf8')) : null
writeFileSync(prevPath, JSON.stringify(snapshot, null, 2))

// ---------------------------------------------------------------- diff + digest
const digest = buildDigest(snapshot, prev)
writeFileSync(join(outDir, 'digest.txt'), digest)
console.log('\n' + digest)

// ---------------------------------------------------------------- helpers
async function listPupils(jar) {
  const r = await follow(jar, `${HUB}/`)
  const start = r.body.indexOf('"pupils":[')
  if (start < 0) return []
  const open = r.body.indexOf('[', start)
  let depth = 0
  for (let i = open; i < r.body.length; i++) {
    if (r.body[i] === '[') depth++
    else if (r.body[i] === ']' && --depth === 0)
      return JSON.parse(r.body.slice(open, i + 1))
  }
  return []
}

async function restoreOriginalPupil(jar, pupils) {
  const original = pupils.find((p) => p.selected)
  if (original) await follow(jar, original.switchPupilUrl)
}

/** pupilSourceId '16863|1405214204|NEMANDI_SKOLI' -> id 1405214204 -> barnnamn */
function childFromSourceId(sourceId, byPupilId) {
  if (!sourceId) return '(okänt)'
  const id = String(sourceId).split('|')[1]
  return byPupilId.get(id) || '(okänt)'
}

function buildDigest(cur, prev) {
  const L = []
  const now = new Date(cur.collectedAt)
  const tmrDate = new Date(now.getTime() + 864e5)
  L.push(
    `Kvällskoll 🌙 — inför imorgon, ${tmrDate.toLocaleDateString('sv-SE', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    })}`
  )
  L.push('')

  if (!prev) {
    L.push('Första körningen — detta blir baslinjen. Inget att jämföra mot ännu.')
  } else {
    const prevN = new Set((prev.notifications || []).map((n) => n.id))
    const prevE = new Map((prev.events || []).map((e) => [e.key, e]))

    const prevT = new Map((prev.tasks || []).map((t) => [t.key, t]))
    const newN = cur.notifications.filter((n) => !prevN.has(n.id))
    const newE = cur.events.filter((e) => e.kind === 'Kalender' && !prevE.has(e.key))
    const changed = cur.events.filter(
      (e) => e.kind === 'Kalender' && prevE.has(e.key) && prevE.get(e.key).title !== e.title
    )
    const gone = (prev.events || []).filter(
      (e) => e.kind === 'Kalender' && !cur.events.some((c) => c.key === e.key)
    )
    const newT = cur.tasks.filter((t) => !prevT.has(t.key))
    const doneT = cur.tasks.filter(
      (t) => prevT.has(t.key) && !isDone(prevT.get(t.key).status) && isDone(t.status)
    )

    const bits = [
      `${newN.length} notis(er)`,
      `${newE.length} kalenderhändelse(r)`,
      `${newT.length} ny(a) uppgift(er)`,
    ]
    if (changed.length) bits.push(`${changed.length} ändrad(e)`)
    if (gone.length) bits.push(`${gone.length} borttagen(borttagna)`)
    if (doneT.length) bits.push(`${doneT.length} klar(a)`)
    L.push(`🆕 Nytt sedan förra körningen: ${bits.join(', ')}`)
    for (const n of newN.slice(0, 15))
      L.push(`  • [${n.appType}] ${n.title}${n.subTitle && n.subTitle !== n.title ? ` — ${n.subTitle}` : ''}  (${displayName(n.child)}, ${fmt(n.date)})`)
    for (const e of newE.slice(0, 15)) L.push(`  • [${displayName(e.child)}] ${e.title}  (${fmt(e.start)})`)
    for (const t of newT.slice(0, 15))
      L.push(`  • [${displayName(t.child)}] NY UPPGIFT: ${t.title}${t.subject ? ` (${t.subject})` : ''} — förfaller ${fmt(t.due)}`)
    for (const t of doneT.slice(0, 10)) L.push(`  • [${displayName(t.child)}] KLAR: ${t.title}`)
    for (const e of changed.slice(0, 10)) L.push(`  • [${displayName(e.child)}] ÄNDRAD: ${e.title}  (${fmt(e.start)})`)
    for (const e of gone.slice(0, 10)) L.push(`  • [${displayName(e.child)}] BORTTAGEN: ${e.title}  (${fmt(e.start)})`)
    if (!newN.length && !newE.length && !newT.length && !changed.length && !gone.length && !doneT.length)
      L.push('  (inga förändringar)')
    L.push('')
  }

  const day = (d) => new Date(d).toISOString().slice(0, 10)
  const tomorrow = plus(1)
  // Idrottsflagga: första dagen framåt som har lektioner (= nästa skoldag).
  let peDay = null
  for (let i = 1; i <= 8 && !peDay; i++) {
    const d = plus(i)
    if (cur.events.some((e) => e.kind === 'Schema' && day(e.start) === d)) peDay = d
  }
  if (peDay) {
    const hits = []
    for (const p of cur.pupils) {
      const pe = cur.events.filter(
        (e) => e.kind === 'Schema' && e.child === p.name && day(e.start) === peDay && isPE(e.title)
      )
      if (pe.length) hits.push(`${displayName(p.name)} (${pe.map((x) => x.start.slice(11, 16)).join(', ')})`)
    }
    if (hits.length) {
      L.push(`🏃 Idrott ${peDay === tomorrow ? 'imorgon' : dayLabel(peDay)} — glöm inte idrottskläderna!`)
      for (const h of hits) L.push(`  • ${h}`)
      L.push('')
    }
  }

  // Skolmat för nästa skoldag (samma källa som HA:s skolmat-sensor).
  const lunch = peDay ? cur.lunch?.calendar?.[peDay] : null
  if (lunch?.length) {
    const when = peDay === tomorrow ? 'imorgon' : dayLabel(peDay)
    L.push(`🍽️ Skolmat ${when}${cur.lunch.school ? ` (${cur.lunch.school})` : ''}`)
    for (const d of lunch) L.push(`  ${d.label || 'Lunch'}: ${d.dish}`)
    L.push('')
  }

  L.push(`🏫 Skoldagen ${peDay === tomorrow ? 'imorgon' : peDay ? dayLabel(peDay) : ''}`.trim())
  for (const p of cur.pupils) {
    const dayEvents = cur.events
      .filter((e) => e.kind === 'Schema' && e.child === p.name && peDay && day(e.start) === peDay)
      .sort((a, b) => a.start.localeCompare(b.start))
    if (!dayEvents.length) {
      L.push(`  ${displayName(p.name)}: ingen skoldag`)
      continue
    }
    const first = dayEvents[0]
    const last = dayEvents[dayEvents.length - 1]
    L.push(`  ${displayName(p.name)}: ${first.start.slice(11, 16)}–${(last.end || last.start).slice(11, 16)}`)
  }
  L.push('')

  const taskLines = []
  for (const p of cur.pupils) {
    const ts = cur.tasks
      .filter((t) => t.child === p.name && !isDone(t.status) && t.due && day(t.due) <= plus(30))
      .sort((a, b) => a.due.localeCompare(b.due))
    if (!ts.length) continue
    taskLines.push(`  ${displayName(p.name)}:`)
    for (const t of ts) {
      const flag = t.overdue ? '  ⚠️ FÖRSENAD' : ''
      taskLines.push(`    ${fmt(t.due)}  ${t.title}${t.subject ? ` (${t.subject})` : ''}${flag}`)
    }
  }
  if (taskLines.length) {
    L.push('📚 Uppgifter — kommande')
    L.push(...taskLines)
    L.push('')
  }

  L.push('📅 Kalender — kommande 7 dagar')
  const week = plus(7)
  for (const p of cur.pupils) {
    const evs = cur.events
      .filter((e) => e.kind === 'Kalender' && e.child === p.name && day(e.start) <= week)
      .sort((a, b) => a.start.localeCompare(b.start))
    if (!evs.length) continue
    L.push(`  ${displayName(p.name)}:`)
    for (const e of evs) L.push(`    ${fmt(e.start)}  ${e.title}${e.extra ? ` (${e.extra})` : ''}`)
  }
  L.push('')

  const att = cur.absences.filter(
    (a) => a.absentToday || a.absentTomorrow || a.pendingLeaveRequests || a.absentSessionsToday.length
  )
  if (att.length) {
    L.push('🕐 Frånvaro')
    for (const a of att) {
      const parts = []
      if (a.absentToday) parts.push('heldag idag')
      if (a.absentTomorrow) parts.push('heldag imorgon')
      for (const s of a.absentSessionsToday) parts.push(`idag: ${s}`)
      for (const s of a.absentSessionsTomorrow) parts.push(`imorgon: ${s}`)
      if (a.pendingLeaveRequests) parts.push(`${a.pendingLeaveRequests} ledighetsansökan`)
      L.push(`  ${displayName(a.child)}: ${parts.join(', ')}`)
    }
    L.push('')
  }

  return L.join('\n')
}

function isDone(status) {
  return /done|complete|klar/i.test(status || '')
}

// Raster, ombyte, lunch m.m. är inte lektioner.
function isBreak(title) {
  return /^(lunch|rast|ombyte|m-tid|studietid|frukost)$/i.test((title || '').trim())
}

// Idrott/gymnastik — så att idrottskläderna kommer med.
function isPE(title) {
  return /\b(idh|idr|idrott|gymnastik|gympa)\b/i.test((title || '').trim()) ||
    /^(idh|idr)$/i.test((title || '').trim())
}

function dayLabel(iso) {
  const d = new Date(iso + 'T12:00:00')
  const wd = ['sön', 'mån', 'tis', 'ons', 'tor', 'fre', 'lör'][d.getDay()]
  return `${wd} ${d.getDate()}/${d.getMonth() + 1}`
}

function fmt(d) {
  if (!d) return ''
  const dt = new Date(d)
  if (Number.isNaN(+dt)) return d
  const date = dt.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })
  const hasTime = typeof d === 'string' && d.length > 10 && !d.endsWith('00:00:00')
  return hasTime ? `${date} ${dt.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })}` : date
}
