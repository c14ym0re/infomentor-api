// Infomentor PoC — inloggning med e-post/lösenord (Mentor-konto).
//
// Flödet är porterat från kolplattformen/dementor.net (Program.cs):
//   1. GET  hub.infomentor.se            -> följ redirects till loginformulär
//   2. POST oauth_token  -> mentor/      -> följ -> formulär med __VIEWSTATE
//   3. POST användarnamn/lösenord + viewstate -> följ
//   4. POST ny oauth_token -> mentor/     -> följ -> tillbaka till hubben
//   5. POST hub .../isauthenticated       -> session etablerad
//
// Ingen extern dependency: Node 18+ built-in fetch + en liten egen cookie-jar.

const HUB = 'https://hub.infomentor.se'
const MENTOR = 'https://infomentor.se/swedish/production/mentor/'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36'

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** Flat cookie-jar. Infomentor/hub delar domän (.infomentor.se), så namn räcker. */
export class CookieJar {
  constructor() {
    this.cookies = new Map()
  }

  store(setCookieHeaders) {
    for (const raw of setCookieHeaders) {
      const pair = raw.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value === '' ) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  names() {
    return [...this.cookies.keys()]
  }

  toJSON() {
    return Object.fromEntries(this.cookies.entries())
  }
}

function log(...args) {
  console.log(...args)
}

async function doFetch(jar, url, init = {}) {
  const headers = { 'User-Agent': UA, ...(init.headers || {}) }
  const cookie = jar.header()
  if (cookie) headers['Cookie'] = cookie
  const res = await fetch(url, { ...init, headers, redirect: 'manual' })
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  if (sc.length) jar.store(sc)
  return res
}

/** Följ redirects manuellt, samla cookies, returnera slutlig URL + body. */
export async function follow(jar, url, init = {}, maxHops = 20) {
  let current = url
  let method = init.method || 'GET'
  let body = init.body
  const headers = { ...(init.headers || {}) }

  for (let hop = 0; hop < maxHops; hop++) {
    const res = await doFetch(jar, current, {
      method,
      body,
      headers,
    })
    if (REDIRECT_STATUS.has(res.status)) {
      const loc = res.headers.get('location')
      if (!loc) return { res, url: current, body: await res.text() }
      const next = new URL(loc, current).toString()
      log(`  → ${res.status} ${next.slice(0, 110)}`)
      current = next
      // 302/303 efter POST blir GET utan body (webbläsarbeteende).
      if (res.status === 302 || res.status === 303) {
        method = 'GET'
        body = undefined
        delete headers['Content-Type']
      }
      continue
    }
    return { res, url: current, body: await res.text() }
  }
  throw new Error(`För många redirects (>${maxHops})`)
}

function formHeaders() {
  return { 'Content-Type': 'application/x-www-form-urlencoded' }
}

function matchOauth(html) {
  const m = html.match(/name="oauth_token"\s+value="([^"]*)"/)
  return m ? decodeHtml(m[1]) : null
}

function hidden(html, name) {
  const re = new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i')
  const m = html.match(re)
  return m ? m[1] : ''
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** Hitta inloggningsformulärets fältnamn (server-control-ID kan variera). */
function findLoginFields(html) {
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0])
  const nameOf = (tag) => {
    const n = tag.match(/name="([^"]+)"/i)
    const t = tag.match(/type="([^"]+)"/i)
    return { name: n && n[1], type: (t && t[1]) || 'text', tag }
  }
  const parsed = inputs.map(nameOf).filter((i) => i.name)
  const password =
    parsed.find((i) => i.type === 'password')?.name ||
    parsed.find((i) => /lykilord|password|passwd/i.test(i.name))?.name
  const username =
    parsed.find(
      (i) => i.type === 'text' && /notandanafn|user|login|email|anvandare/i.test(i.name)
    )?.name || parsed.find((i) => i.type === 'text')?.name
  const submit =
    parsed.find((i) => i.type === 'submit')?.name ||
    parsed.find((i) => /login|logga/i.test(i.name))?.name
  return { username, password, submit }
}

/**
 * Logga in och returnera en cookie-jar med en levande hub-session.
 * @param {{username: string, password: string}} creds
 */
export async function login(creds) {
  const jar = new CookieJar()
  log('[1] GET hub-root …')
  let r = await follow(jar, `${HUB}/`)
  let html = r.body

  let oauth = matchOauth(html)
  if (oauth) {
    log('[2] POST oauth_token → mentor/ …')
    r = await follow(jar, MENTOR, {
      method: 'POST',
      headers: formHeaders(),
      body: new URLSearchParams({ oauth_token: oauth }).toString(),
    })
    html = r.body
  } else {
    log('    (ingen oauth_token på hub-roten — använder nuvarande sida)')
  }

  const viewState = hidden(html, '__VIEWSTATE')
  if (!viewState) {
    throw new Error(
      'Hittade inget __VIEWSTATE — nådde vi inloggningsformuläret? ' +
        `URL=${r.url.slice(0, 120)} body=${html.slice(0, 200).replace(/\s+/g, ' ')}`
    )
  }
  const viewStateGen = hidden(html, '__VIEWSTATEGENERATOR')
  const eventValidation = hidden(html, '__EVENTVALIDATION')

  let fields = findLoginFields(html)
  if (!fields.username || !fields.password) {
    log('    auto-detektering misslyckades, använder dementor-namn')
    fields = {
      username: 'login_ascx$txtNotandanafn',
      password: 'login_ascx$txtLykilord',
      submit: 'login_ascx$btnLogin',
    }
  } else {
    log(`[3] formulärfält: user=${fields.username} pass=${fields.password} submit=${fields.submit}`)
  }

  const form = new URLSearchParams()
  form.set(fields.username, creds.username)
  form.set(fields.password, creds.password)
  if (fields.submit) form.set(fields.submit, 'Logga in')
  form.set('__VIEWSTATE', viewState)
  form.set('__VIEWSTATEGENERATOR', viewStateGen)
  form.set('__EVENTVALIDATION', eventValidation)
  form.set('__EVENTTARGET', '')
  form.set('__EVENTARGUMENT', '')

  log('[4] POST inloggningsuppgifter …')
  r = await follow(jar, MENTOR, {
    method: 'POST',
    headers: formHeaders(),
    body: form.toString(),
  })
  html = r.body

  oauth = matchOauth(html)
  if (oauth) {
    log('[5] POST oauth_token (tillbaka till hub) …')
    r = await follow(jar, MENTOR, {
      method: 'POST',
      headers: formHeaders(),
      body: new URLSearchParams({ oauth_token: oauth }).toString(),
    })
    html = r.body
  } else {
    log('    (ingen ny oauth_token — fortsätter ändå)')
  }

  log('[6] POST isauthenticated …')
  await follow(jar, `${HUB}/authentication/authentication/isauthenticated/?_=${Date.now()}`, {
    method: 'POST',
  })

  log('[7] Verifierar session via hub-roten …')
  r = await follow(jar, `${HUB}/`)
  if (!r.body.includes('selectedPupilName')) {
    log('    ⚠️  kunde inte se selectedPupilName i hub-HTML — sessionen kan vara död')
  } else {
    log('    ✅ session ser levande ut (selectedPupilName hittad)')
  }

  return { jar, hubRootHtml: r.body }
}

/**
 * POST mot en hub-endpoint med en etablerad session.
 * Returnerar { status, text, json } — tom body = död session (200/tom).
 */
export async function hubPost(jar, path, body) {
  const headers = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  }
  const res = await doFetch(jar, `${HUB}${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* inte JSON */
  }
  return { status: res.status, text, json }
}

export { HUB, MENTOR }
