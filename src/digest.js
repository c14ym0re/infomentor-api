// Kvällssammanfattningen som text. Tar ett snapshot + (valfritt) händelser.
// Ren funktion — ingen I/O — så den kan användas av både collect.js och watch.js.
import { displayName } from './names.js'

const iso = (d) => d.toISOString().slice(0, 10)
const plus = (n) => iso(new Date(Date.now() + n * 864e5))
const day = (d) => String(d || '').slice(0, 10)
const isDone = (s) => /done|complete|klar/i.test(s || '')
const isPE = (t) => /\b(idh|idr|idrott|gymnastik|gympa)\b/i.test((t || '').trim())

function dayLabel(isoDate) {
  const d = new Date(isoDate + 'T12:00:00')
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

/**
 * @param {object} snapshot
 * @param {{events?: object[] | null, title?: string}} [opts]
 *        events = null/utelämnad → "första körningen"; [] → inga förändringar
 */
export function buildDigest(snapshot, opts = {}) {
  const L = []
  const now = new Date(snapshot.collectedAt)
  const tmr = new Date(now.getTime() + 864e5)
  L.push(
    opts.title ||
      `Kvällskoll 🌙 — inför imorgon, ${tmr.toLocaleDateString('sv-SE', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })}`
  )
  L.push('')

  const events = opts.events
  if (events === undefined || events === null) {
    L.push('Första körningen — detta blir baslinjen. Inget att jämföra mot ännu.')
    L.push('')
  } else {
    renderChanges(L, events)
  }

  const tomorrow = plus(1)
  let schoolDay = null
  for (let i = 1; i <= 8 && !schoolDay; i++) {
    const d = plus(i)
    if (snapshot.events.some((e) => e.kind === 'Schema' && day(e.start) === d)) schoolDay = d
  }

  // Idrott
  if (schoolDay) {
    const hits = []
    for (const p of snapshot.pupils) {
      const pe = snapshot.events.filter(
        (e) => e.kind === 'Schema' && e.child === p.name && day(e.start) === schoolDay && isPE(e.title)
      )
      if (pe.length) hits.push(`${displayName(p.name)} (${pe.map((x) => String(x.start).slice(11, 16)).join(', ')})`)
    }
    if (hits.length) {
      L.push(`🏃 Idrott ${schoolDay === tomorrow ? 'imorgon' : dayLabel(schoolDay)} — glöm inte idrottskläderna!`)
      for (const h of hits) L.push(`  • ${h}`)
      L.push('')
    }
  }

  // Lunch
  const lunch = schoolDay ? snapshot.lunch?.calendar?.[schoolDay] : null
  if (lunch?.length) {
    const when = schoolDay === tomorrow ? 'imorgon' : dayLabel(schoolDay)
    L.push(`🍽️ Skolmat ${when}${snapshot.lunch.school ? ` (${snapshot.lunch.school})` : ''}`)
    for (const d of lunch) L.push(`  ${d.label || 'Lunch'}: ${d.dish}`)
    L.push('')
  }

  // Skoldagen
  L.push(`🏫 Skoldagen ${schoolDay === tomorrow ? 'imorgon' : schoolDay ? dayLabel(schoolDay) : ''}`.trim())
  for (const p of snapshot.pupils) {
    const dayEvents = snapshot.events
      .filter((e) => e.kind === 'Schema' && e.child === p.name && schoolDay && day(e.start) === schoolDay)
      .sort((a, b) => a.start.localeCompare(b.start))
    if (!dayEvents.length) {
      L.push(`  ${displayName(p.name)}: ingen skoldag`)
      continue
    }
    const first = dayEvents[0]
    const last = dayEvents[dayEvents.length - 1]
    L.push(`  ${displayName(p.name)}: ${String(first.start).slice(11, 16)}–${String(last.end || last.start).slice(11, 16)}`)
  }
  L.push('')

  // Uppgifter
  const taskLines = []
  for (const p of snapshot.pupils) {
    const ts = snapshot.tasks
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

  // Kalender
  const week = plus(7)
  const calLines = []
  for (const p of snapshot.pupils) {
    const evs = snapshot.events
      .filter((e) => e.kind === 'Kalender' && e.child === p.name && day(e.start) <= week)
      .sort((a, b) => a.start.localeCompare(b.start))
    if (!evs.length) continue
    calLines.push(`  ${displayName(p.name)}:`)
    for (const e of evs) calLines.push(`    ${fmt(e.start)}  ${e.title}${e.extra ? ` (${e.extra})` : ''}`)
  }
  if (calLines.length) {
    L.push('📅 Kalender — kommande 7 dagar')
    L.push(...calLines)
    L.push('')
  }

  // Frånvaro
  const att = snapshot.absences.filter(
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

/** Formaterar händelser som punktrader (delas av digest och akuta notiser). */
export function formatEventLines(events) {
  const lines = []
  for (const n of events.filter((e) => e.type === 'notification.new').slice(0, 15))
    lines.push(
      `• [${n.appType || 'Notis'}] ${n.title}${n.subTitle && n.subTitle !== n.title ? ` — ${n.subTitle}` : ''}  (${displayName(n.child)}, ${fmt(n.date)})`
    )
  for (const e of events.filter((e) => e.type === 'calendar.new').slice(0, 15))
    lines.push(`• [${displayName(e.child)}] Nytt i kalendern: ${e.title}  (${fmt(e.start)})`)
  for (const t of events.filter((e) => e.type === 'task.new').slice(0, 15))
    lines.push(`• [${displayName(t.child)}] NY UPPGIFT: ${t.title}${t.subject ? ` (${t.subject})` : ''} — förfaller ${fmt(t.due)}`)
  for (const t of events.filter((e) => e.type === 'task.done').slice(0, 10))
    lines.push(`• [${displayName(t.child)}] KLAR: ${t.title}`)
  for (const e of events.filter((e) => e.type === 'calendar.changed').slice(0, 10))
    lines.push(`• [${displayName(e.child)}] ÄNDRAD: ${e.title}  (${fmt(e.start)})`)
  for (const e of events.filter((e) => e.type === 'calendar.removed').slice(0, 10))
    lines.push(`• [${displayName(e.child)}] BORTTAGEN: ${e.title}  (${fmt(e.start)})`)
  for (const a of events.filter((e) => e.type.startsWith('absence.')).slice(0, 10))
    lines.push(`• [${displayName(a.child)}] FRÅNVARO: ${a.title}`)
  return lines
}

function countBits(events) {
  const c = (t) => events.filter((e) => e.type === t).length
  const bits = [`${c('notification.new')} notis(er)`, `${c('calendar.new')} kalenderhändelse(r)`, `${c('task.new')} ny(a) uppgift(er)`]
  if (c('calendar.changed')) bits.push(`${c('calendar.changed')} ändrad(e)`)
  if (c('calendar.removed')) bits.push(`${c('calendar.removed')} borttagen(borttagna)`)
  if (c('task.done')) bits.push(`${c('task.done')} klar(a)`)
  const abs = events.filter((e) => e.type.startsWith('absence.')).length
  if (abs) bits.push(`${abs} frånvarohändelse(r)`)
  return bits
}

function renderChanges(L, events) {
  L.push(`🆕 Nytt sedan förra sammanställningen: ${countBits(events).join(', ')}`)
  for (const line of formatEventLines(events)) L.push(`  ${line}`)
  if (!events.length) L.push('  (inga förändringar)')
  L.push('')
}
