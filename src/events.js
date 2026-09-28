// Händelsemotor — ren, sidoeffektfri och enhetstestbar.
//
// Flattar ett snapshot till typade poster med stabila nycklar och jämför mot
// föregående läge. Returnerar en lista av händelser. Ingen I/O, ingen tid, inga
// beroenden — allt testbart.

/** Prioritet styr om en händelse får gå ut direkt eller batchas till kvällsmejlet. */
export const IMMEDIATE = 'immediate'
export const DIGEST = 'digest'

const KIND_PRIORITY = {
  'task.new': IMMEDIATE,
  'task.changed': IMMEDIATE,
  'task.done': DIGEST,
  'calendar.new': DIGEST,
  'calendar.changed': IMMEDIATE,
  'calendar.removed': IMMEDIATE,
  'notification.new': IMMEDIATE,
  'news.new': DIGEST,
  'absence.registered': IMMEDIATE,
  'absence.changed': IMMEDIATE,
  'absence.requested': IMMEDIATE,
}

/** Fält som, när de ändras, gör att en post räknas som ändrad. */
const WATCHED_FIELDS = {
  task: ['title', 'subject', 'due', 'status'],
  calendar: ['title', 'start', 'end', 'extra'],
  notification: ['title', 'subTitle', 'date'],
  lesson: [],
  news: ['title', 'published'],
  absence: ['absentToday', 'absentTomorrow', 'pendingLeave'],
}

/** Gör om ett snapshot (från collect) till en platt lista av poster. */
export function itemsFromSnapshot(snap) {
  const items = []
  for (const n of snap.notifications ?? []) {
    items.push({
      kind: 'notification',
      key: `notification|${n.id}`,
      child: n.child,
      id: String(n.id),
      title: n.title,
      subTitle: n.subTitle,
      date: n.date,
      url: n.url,
      appType: n.appType,
    })
  }
  for (const t of snap.tasks ?? []) {
    items.push({
      kind: 'task',
      key: t.key,
      child: t.child,
      id: t.id,
      title: t.title,
      subject: t.subject,
      due: t.due,
      status: t.status,
      overdue: !!t.overdue,
      url: t.url,
    })
  }
  for (const e of snap.events ?? []) {
    const kind = e.kind === 'Kalender' ? 'calendar' : 'lesson'
    items.push({
      kind,
      key: e.key,
      child: e.child,
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: !!e.allDay,
      extra: e.extra,
      url: e.url,
    })
  }
  for (const a of snap.absences ?? []) {
    items.push({
      kind: 'absence',
      key: `absence|${a.child}`,
      child: a.child,
      absentToday: !!a.absentToday,
      absentTomorrow: !!a.absentTomorrow,
      pendingLeave: a.pendingLeaveRequests ?? 0,
      sessionsToday: a.absentSessionsToday ?? [],
    })
  }
  for (const n of snap.news ?? []) {
    items.push({
      kind: 'news',
      key: `news|${n.id}`,
      child: null,
      id: String(n.id),
      title: n.title,
      published: n.published,
    })
  }
  return items
}

export function indexByKey(items) {
  const map = new Map()
  for (const it of items) map.set(it.key, it)
  return map
}

function changedFields(prev, next) {
  const fields = WATCHED_FIELDS[next.kind] ?? []
  const out = []
  for (const f of fields) {
    const a = prev[f]
    const b = next[f]
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: f, from: a, to: b })
  }
  return out
}

/** Ger en ändrad post en meningsfull händelsetyp. */
function classifyChange(item, changes) {
  if (item.kind === 'task') {
    const done = changes.some((c) => c.field === 'status' && /done|complete|klar/i.test(c.to || ''))
    return done ? 'done' : 'changed'
  }
  if (item.kind === 'absence') {
    const leftUp = changes.some((c) => c.field === 'pendingLeave' && Number(c.to || 0) > Number(c.from || 0))
    if (leftUp) return 'requested'
    const becameAbsent = changes.some(
      (c) => (c.field === 'absentToday' || c.field === 'absentTomorrow') && !c.from && c.to
    )
    return becameAbsent ? 'registered' : 'changed'
  }
  return 'changed'
}

function mkEvent(item, type, extra = {}) {
  // Hela posten följer med så digest/historik har titel, datum, ämne m.m.
  return {
    ...item,
    type: `${item.kind}.${type}`,
    priority: KIND_PRIORITY[`${item.kind}.${type}`] ?? DIGEST,
    ...extra,
  }
}

/**
 * Jämför föregående index med aktuella poster.
 * @param {Map<string, object>} prevIndex — från indexByKey()
 * @param {object[]} items — aktuella poster
 * @param {{ignoreKinds?: string[]}} [opts]
 * @returns {object[]} händelser (nya/ändrade/borttagna)
 */
export function detectChanges(prevIndex, items, opts = {}) {
  const ignore = new Set(opts.ignoreKinds ?? [])
  const events = []
  const seen = new Set()

  for (const it of items) {
    seen.add(it.key)
    if (ignore.has(it.kind)) continue
    const prev = prevIndex.get(it.key)
    if (!prev) {
      events.push(mkEvent(it, 'new'))
      continue
    }
    const changes = changedFields(prev, it)
    if (changes.length) {
      events.push(mkEvent(it, classifyChange(it, changes), { changes }))
    }
  }

  // Borttaget: bara för kalender och uppgifter (schema rullar ändå).
  for (const [key, prev] of prevIndex) {
    if (seen.has(key)) continue
    if (ignore.has(prev.kind)) continue
    if (prev.kind === 'calendar' || prev.kind === 'task') events.push(mkEvent(prev, 'removed'))
  }

  return events
}

/** En rad i en batchad digest, eller tom sträng om inget. */
export function summarize(events) {
  const byChild = new Map()
  for (const e of events) {
    const c = e.child ?? 'Alla'
    if (!byChild.has(c)) byChild.set(c, [])
    byChild.get(c).push(e)
  }
  return [...byChild.entries()].map(([child, list]) => ({ child, count: list.length, events: list }))
}
