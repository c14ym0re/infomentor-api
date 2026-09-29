// Planeringar (appen uolv2, "Unit of Learning").
//
//   POST /UolV2/UolV2/GetUols  {}      → listan (id, titel, ämnes-id:n, state)
//   POST /UolV2/UolV2/GetUol   {id}    → en planering: sektionerna
//                                        uol (översikt) / syllabus (pedagogisk
//                                        planering) / statement (kriterier)
//
// Body-nyckeln för GetUol måste vara just `id` — `uolId`/`Id` ger HTTP 500.
// Detaljen kostar ett anrop per planering, så gather hämtar den bara när den
// behövs: nya planeringar, och en gång i dygnet (eller när hubben aviserar
// `UolUpdated`) för att upptäcka ändringar. Allt här är rent — ingen I/O.

const TAG_RE = /<[^>]+>/g
const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
}

/** Enkel HTML → läsbar text (samma idé som integrations-util). */
export function stripHtml(value) {
  return String(value ?? '')
    .replace(TAG_RE, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim()
}

/** GetUols (eller appData) → planeringar med ämnesnamn i stället för id:n. */
export function normalizePlans(raw = {}) {
  const subjects = new Map((raw.subjects ?? []).map((s) => [String(s.id), s.name]))
  return (raw.uols ?? []).map((u) => ({
    id: String(u.id),
    title: String(u.title ?? '').trim(),
    subjects: (u.subjects ?? []).map((id) => subjects.get(String(id))).filter(Boolean),
    state: String(u.state ?? ''),
  }))
}

/**
 * Lärarlistan kommer som "Efternamn,   Förnamn" parade med kommatecken:
 * "Kvarnbrink,   Erika,Gomez Fraga,  Angeles" → ['Erika Kvarnbrink', 'Angeles Gomez Fraga']
 */
export function parseTeachers(value) {
  const parts = String(value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  const out = []
  for (let i = 0; i + 1 < parts.length; i += 2) out.push(`${parts[i + 1]} ${parts[i]}`)
  if (parts.length % 2) out.push(parts[parts.length - 1])
  return out
}

/** 'Tidplan:' och 'Kunskapsmål - När vi …' → 'Tidplan' / 'Kunskapsmål'. */
export function planFieldKey(label) {
  return String(label ?? '')
    .split(' - ')[0]
    .replace(/:\s*$/, '')
    .trim()
}

const dayOf = (value) => String(value ?? '').slice(0, 10)

function brief(text, max = 300) {
  return text.length > max ? `${text.slice(0, max).trimEnd()} …` : text
}

/**
 * GetUol → det vi visar och jämför: period, lärare, termins/årskursetiketter,
 * den pedagogiska planeringens kategorier och en kort beskrivning.
 */
export function planInfo(detail = {}) {
  const sections = detail.sections ?? []
  const rows = sections.find((s) => s.type === 'uol')?.overview ?? []
  const overview = new Map(
    rows.filter((r) => r.label).map((r) => [String(r.label).trim(), String(r.value ?? '')])
  )
  const fields = {}
  for (const part of sections.find((s) => s.type === 'syllabus')?.sections ?? []) {
    for (const field of part.fields ?? []) {
      const key = planFieldKey(field.label)
      const text = stripHtml(field.value)
      // Tomma fält hoppas över — fylls de i senare blir de en tillagd nyckel.
      if (key && text) fields[key] = text
    }
  }
  const description =
    brief(stripHtml(overview.get('Beskrivning') ?? '')) || brief(fields['Översikt'] ?? '')
  return {
    term: String(overview.get('Termin') ?? ''),
    start: dayOf(overview.get('Startdatum')),
    end: dayOf(overview.get('Slutdatum')),
    grade: String(overview.get('Årskurs') ?? ''),
    teachers: parseTeachers(overview.get('Lärare')),
    fields,
    description,
  }
}

/**
 * GetAllTasks → uppgifterna som hör till planeringen, trimmade och sorterade
 * på förfallodatum. Beskrivningar och delmål lämnas utanför — allt som behövs
 * för att visa kopplingen, och inget som sväller attributen.
 */
export function normalizePlanTasks(raw = {}) {
  return (raw.tasks ?? [])
    .map((task) => {
      const item = {
        id: String(task.id ?? ''),
        title: String(task.title ?? '').trim(),
        due: dayOf(task.dueDate),
        status: String(task.status ?? ''),
      }
      const total = Number(task.milestoneCount ?? 0)
      if (total > 0) item.milestones = `${Number(task.milestonesComplete ?? 0)}/${total}`
      return item
    })
    .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))
}

/** Fältnamn → läsbar etikett i mejlet. */
const PLAN_LABELS = {
  title: 'Rubrik',
  subjects: 'Ämne',
  state: 'Status',
  start: 'Startdatum',
  end: 'Slutdatum',
  teachers: 'Lärare',
  term: 'Termin',
}

const show = (value) => (Array.isArray(value) ? value.join(', ') : String(value ?? ''))

/** Vad som ändrats mellan två planeringsposter — läsbart för mejlet. */
export function planChanges(prev = {}, next = {}) {
  const out = []
  for (const [field, label] of Object.entries(PLAN_LABELS)) {
    if (JSON.stringify(prev[field] ?? null) !== JSON.stringify(next[field] ?? null)) {
      out.push({ label, from: show(prev[field]), to: show(next[field]) })
    }
  }
  const before = prev.fields ?? {}
  const after = next.fields ?? {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if ((before[key] ?? '') !== (after[key] ?? '')) {
      out.push({ label: key, from: before[key] ?? '', to: after[key] ?? '' })
    }
  }
  return out
}

/** '2026-08-18' + '2026-12-18' → '18/8–18/12' (för mejl och panel). */
export function formatPeriod(start, end) {
  const short = (value) => {
    const [, month, day] = String(value ?? '').split('-')
    if (!month || !day) return ''
    return `${Number(day)}/${Number(month)}`
  }
  const from = short(start)
  const to = short(end)
  if (!from) return ''
  return to && to !== from ? `${from}–${to}` : from
}
