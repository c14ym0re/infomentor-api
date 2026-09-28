// Insamling — logga in och hämta allt, returnera ett snapshot.
// Delas av collect.js (kvällsmejl) och watch.js (pollare).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, hubPost, follow } from './infomentor.js'
import { fetchLunchCalendar, lunchConfig } from './lunch.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iso = (d) => d.toISOString().slice(0, 10)
const plus = (n) => iso(new Date(Date.now() + n * 864e5))

/** Raster, ombyte, lunch m.m. är inte lektioner. */
export function isBreak(title) {
  return /^(lunch|rast|ombyte|m-tid|studietid|frukost)$/i.test((title || '').trim())
}

export async function listPupils(jar) {
  const r = await follow(jar, 'https://hub.infomentor.se/')
  const start = r.body.indexOf('"pupils":[')
  if (start < 0) return []
  const open = r.body.indexOf('[', start)
  let depth = 0
  for (let i = open; i < r.body.length; i++) {
    if (r.body[i] === '[') depth++
    else if (r.body[i] === ']' && --depth === 0) return JSON.parse(r.body.slice(open, i + 1))
  }
  return []
}

function restoreOriginalPupil(jar, pupils) {
  const original = pupils.find((p) => p.selected)
  return original ? follow(jar, original.switchPupilUrl) : Promise.resolve()
}

/** pupilSourceId '16863|<id>|NEMANDI_SKOLI' -> id -> barnnamn */
function childFromSourceId(sourceId, byPupilId) {
  if (!sourceId) return '(okänt)'
  const id = String(sourceId).split('|')[1]
  return byPupilId.get(id) || '(okänt)'
}

/**
 * Loggar in och samlar in allt.
 * @param {{credentialsPath?: string, log?: (msg: string) => void}} [opts]
 * @returns {Promise<object>} snapshot
 */
export async function gather(opts = {}) {
  const log = opts.log ?? (() => {})
  const creds = JSON.parse(readFileSync(opts.credentialsPath || join(root, 'credentials.json'), 'utf8'))
  const { jar } = await login({ username: creds.username || creds.email, password: creds.password })

  const pupils = await listPupils(jar)
  const byPupilId = new Map(pupils.map((p) => [String(p.id), p.name]))
  log(`${pupils.length} barn hittade`)

  const notifications = (
    (await hubPost(jar, '/NotificationApp/NotificationApp/GetNotifications', {})).json?.notifications ?? []
  ).map((n) => ({
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

  const events = []
  const tasks = []
  const absences = []
  for (const p of pupils) {
    await follow(jar, p.switchPupilUrl)

    const cal = (await hubPost(jar, '/calendarv2/calendarv2/getentries', {
      startDate: iso(new Date()),
      endDate: plus(30),
    })).json ?? []
    for (const c of Array.isArray(cal) ? cal : []) {
      // Kalenderposter med url /task/show/ är uppgifter — listas separat.
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

    // gettimetablelist respekterar intervallet (appData gör det inte).
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
      log(`[lunch] hämtning misslyckades: ${err.message}`)
    }
  }

  return {
    collectedAt: new Date().toISOString(),
    pupils: pupils.map((p) => ({ id: String(p.id), name: p.name })),
    notifications,
    news,
    events,
    tasks,
    absences,
    lunch: lunchCfg ? { school: lunchCfg.school || '', unitId: lunchCfg.unitId, calendar: lunchCalendar } : null,
  }
}
