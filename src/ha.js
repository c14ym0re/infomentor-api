// Home Assistant-brygga via MQTT Discovery.
// Ren funktion: snapshot → lista av MQTT-meddelanden (testbar utan broker).
// HA plockar upp enheterna automatiskt när discovery-topics publiceras retained.
import { displayName } from './names.js'

export function slug(s) {
  return (
    String(s)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'x'
  )
}

const dayOf = (s) => String(s || '').slice(0, 10)
const timeOf = (s) => String(s || '').slice(11, 16)
const isDone = (s) => /done|complete|klar/i.test(s || '')
const isPE = (t) => /\b(idh|idr|idrott|gymnastik|gympa)\b/i.test((t || '').trim())

function nextSchoolDay(snapshot, fromISO) {
  for (let i = 1; i <= 8; i++) {
    const d = addDays(fromISO, i)
    if ((snapshot.events ?? []).some((e) => e.kind === 'Schema' && dayOf(e.start) === d)) return d
  }
  return null
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Bygger enhetsdefinitioner ur ett snapshot. */
export function buildEntities(snapshot) {
  const today = dayOf(snapshot.collectedAt)
  const week = addDays(today, 7)
  const schoolDay = nextSchoolDay(snapshot, today)
  const device = { identifiers: ['infomentor'], name: 'Infomentor', manufacturer: 'infomentor-api' }
  const ents = []

  for (const p of snapshot.pupils ?? []) {
    const child = p.name
    const who = displayName(child)
    const whoSlug = slug(who)
    const base = `infomentor_${whoSlug}`

    const lessons = (snapshot.events ?? [])
      .filter((e) => e.kind === 'Schema' && e.child === child && schoolDay && dayOf(e.start) === schoolDay)
      .sort((a, b) => a.start.localeCompare(b.start))
    const skoldag = lessons.length ? `${timeOf(lessons[0].start)}–${timeOf(lessons[lessons.length - 1].end || lessons[0].start)}` : ''

    ents.push({
      id: `${base}_skoldag`,
      name: `${who} skoldag`,
      stateTopic: `${whoSlug}/skoldag`,
      value: skoldag || '–',
      icon: 'mdi:school',
      attributes: { barn: who, datum: schoolDay },
    })

    const tasks = (snapshot.tasks ?? []).filter(
      (t) => t.child === child && !isDone(t.status) && t.due && dayOf(t.due) >= today && dayOf(t.due) <= week
    )
    ents.push({
      id: `${base}_uppgifter`,
      name: `${who} uppgifter`,
      stateTopic: `${whoSlug}/uppgifter`,
      value: tasks.length,
      icon: 'mdi:clipboard-text-outline',
      attributes: { barn: who, lista: tasks.map((t) => `${t.title} (${dayOf(t.due)})`) },
    })

    const nextEvent = (snapshot.events ?? [])
      .filter((e) => e.kind === 'Kalender' && e.child === child && dayOf(e.start) >= today)
      .sort((a, b) => a.start.localeCompare(b.start))[0]
    ents.push({
      id: `${base}_nasta_handelse`,
      name: `${who} nästa händelse`,
      stateTopic: `${whoSlug}/nasta_handelse`,
      value: nextEvent ? nextEvent.title : 'Inget inbokat',
      icon: 'mdi:calendar-star',
      attributes: { barn: who, datum: nextEvent ? dayOf(nextEvent.start) : null },
    })

    const pe = schoolDay
      ? lessons.filter((l) => isPE(l.title))
      : []
    ents.push({
      id: `${base}_idrott`,
      name: `${who} idrott nästa skoldag`,
      stateTopic: `${whoSlug}/idrott`,
      type: 'binary_sensor',
      deviceClass: 'running',
      value: pe.length ? 'ON' : 'OFF',
      icon: 'mdi:run',
      attributes: { barn: who, dag: schoolDay, tider: pe.map((l) => timeOf(l.start)) },
    })
  }

  // Gemensamt: lunch
  const lunch = schoolDay ? snapshot.lunch?.calendar?.[schoolDay] : null
  if (lunch?.length) {
    ents.push({
      id: 'infomentor_lunch',
      name: 'Skolmat nästa skoldag',
      stateTopic: 'lunch',
      value: lunch.map((d) => d.dish).join('; '),
      icon: 'mdi:silverware-fork-knife',
      attributes: {
        dag: schoolDay,
        skola: snapshot.lunch.school || '',
        ratter: lunch.map((d) => ({ label: d.label, dish: d.dish })),
      },
    })
  }

  return { entities: ents, device }
}

/** Discovery-meddelanden (retained) så HA skapar enheterna. */
export function discoveryMessages(snapshot, { discoveryPrefix = 'homeassistant' } = {}) {
  const { entities, device } = buildEntities(snapshot)
  return entities.map((e) => {
    const component = e.type === 'binary_sensor' ? 'binary_sensor' : 'sensor'
    const payload = {
      name: e.name,
      unique_id: e.id,
      object_id: e.id,
      state_topic: `infomentor/${e.stateTopic}`,
      json_attributes_topic: `infomentor/${e.stateTopic}/attributes`,
      icon: e.icon,
      device,
    }
    if (component === 'binary_sensor') {
      payload.payload_on = 'ON'
      payload.payload_off = 'OFF'
      if (e.deviceClass) payload.device_class = e.deviceClass
    } else {
      payload.state_class = typeof e.value === 'number' ? 'measurement' : undefined
    }
    return {
      topic: `${discoveryPrefix}/${component}/${e.id}/config`,
      payload: JSON.stringify(payload),
      retain: true,
    }
  })
}

/** Tillståndsmeddelanden (retained) — värde + attribut per enhet. */
export function stateMessages(snapshot) {
  const { entities } = buildEntities(snapshot)
  const out = []
  for (const e of entities) {
    out.push({ topic: `infomentor/${e.stateTopic}`, payload: String(e.value), retain: true })
    out.push({
      topic: `infomentor/${e.stateTopic}/attributes`,
      payload: JSON.stringify(e.attributes ?? {}),
      retain: true,
    })
  }
  return out
}

/** Publicerar discovery + tillstånd via en MqttClient. */
export async function publishAll(client, snapshot, opts = {}) {
  for (const m of discoveryMessages(snapshot, opts)) await client.publish(m.topic, m.payload, { retain: true })
  for (const m of stateMessages(snapshot)) await client.publish(m.topic, m.payload, { retain: true })
}
