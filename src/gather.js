// Insamling — logga in och hämta allt, returnera ett snapshot.
// Delas av collect.js (kvällsmejl) och watch.js (pollare).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, hubPost, follow } from './infomentor.js'
import { fetchLunchCalendar, lunchConfig } from './lunch.js'
import { normalizePlans, normalizePlanTasks, planInfo } from './plans.js'

/** Hur länge en hämtad planeringsdetalj får ligga innan vi kollar om den ändrats. */
const PLAN_DETAIL_TTL_MS = 24 * 3600 * 1000

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
 * @param {{credentialsPath?: string, log?: (msg: string) => void,
 *          knownPlans?: Map<string, {at: number, info: object}> | null}} [opts]
 *        knownPlans — id → senast hämtade detalj (med tidsstämpel). En detalj
 *        hämtas bara för nya planeringar, när den är äldre än ett dygn, eller
 *        när hubben aviserat `UolUpdated`. `null` = hämta ingen detalj
 *        (baslinje/första körningen).
 * @returns {Promise<object>} snapshot
 */
export async function gather(opts = {}) {
  const log = opts.log ?? (() => {})
  const knownPlans = opts.knownPlans ?? null
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

  // Hubben aviserar ändrade planeringar som `appType: Uol`, `type: UolUpdated`
  // med url `#/uolv2/show/<id>`. Då hämtar vi om detaljen direkt i stället för
  // att vänta på dygnsrefreshen.
  const updatedPlans = new Set()
  for (const n of notifications) {
    const match = /\/uolv2\/show\/(\d+)/.exec(n.url || '')
    if (match && /^uol$/i.test(n.appType || '') && /updated/i.test(n.type || '')) {
      updatedPlans.add(`${n.child}|${match[1]}`)
    }
  }

  const events = []
  const tasks = []
  const plans = []
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

    const uolRes = (await hubPost(jar, '/UolV2/UolV2/GetUols', {})).json ?? {}
    const pupilPlans = []
    for (const plan of normalizePlans(uolRes)) {
      const known = knownPlans?.get(plan.id) ?? null
      // Ett detaljanrop per planering: hämta bara när den är ny, kan ha
      // ändrats (dygnsrefresh eller UolUpdated) — och aldrig för avslutade.
      const stale = !known || Date.now() - (known.at || 0) > PLAN_DETAIL_TTL_MS
      const fetchDetail =
        !!knownPlans &&
        plan.state !== 'finished' &&
        (stale || updatedPlans.has(`${p.name}|${plan.id}`))
      let info = known?.info ?? {}
      if (fetchDetail) {
        try {
          const detail = (await hubPost(jar, '/UolV2/UolV2/GetUol', { id: plan.id })).json
          info = planInfo(detail)
        } catch (err) {
          log(`[plan] kunde inte hämta detaljen för ${plan.id}: ${err.message}`)
        }
        // Samma pass: uppgifterna som hör till planeringen (ett anrop till, men
        // bara när detaljen ändå hämtas).
        try {
          const res = (await hubPost(jar, '/UolV2/UolV2/GetAllTasks', { id: plan.id })).json
          const assignments = normalizePlanTasks(res)
          if (assignments.length) info = { ...info, assignments }
        } catch (err) {
          log(`[plan] kunde inte hämta uppgifterna för ${plan.id}: ${err.message}`)
        }
      }
      pupilPlans.push({
        key: `${p.name}|plan|${plan.id}`,
        child: p.name,
        id: plan.id,
        title: plan.title,
        subjects: plan.subjects,
        state: plan.state,
        url: `/#/uolv2/show/${plan.id}`,
        ...info,
        fetchedAt: fetchDetail ? Date.now() : known?.at,
      })
    }

    // Omvänd koppling (uppgift → planering) så att mejlets uppgiftslarm kan säga
    // vilket arbetsområde uppgiften hör till. Öppna planeringar går före.
    const planByTask = new Map()
    for (const plan of pupilPlans) {
      if (plan.state === 'finished') continue
      for (const a of plan.assignments ?? []) {
        if (!planByTask.has(a.id)) planByTask.set(a.id, plan.title)
      }
    }
    for (const task of tasks) {
      if (task.child === p.name && planByTask.has(task.id)) task.plan = planByTask.get(task.id)
    }
    plans.push(...pupilPlans)
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
    plans,
    absences,
    lunch: lunchCfg ? { school: lunchCfg.school || '', unitId: lunchCfg.unitId, calendar: lunchCalendar } : null,
  }
}
