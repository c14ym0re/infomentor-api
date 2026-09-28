// Diagnostik utan konto: visar vart hubben skickar en oinloggad klient,
// och vilka formulärfält inloggningssidan har. Användbart för felsökning.
//   node src/flowcheck.js
import { CookieJar, follow } from './infomentor.js'

const jar = new CookieJar()
const r = await follow(jar, 'https://hub.infomentor.se/')
console.log('slutlig URL :', r.url)
console.log('status      :', r.res.status)
console.log('body-längd  :', r.body.length)
console.log('oauth_token :', /name="oauth_token"/.test(r.body))
console.log('__VIEWSTATE :', /__VIEWSTATE/.test(r.body))

const inputs = [...r.body.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0])
console.log('\ninput-fält:')
for (const tag of inputs) {
  const name = tag.match(/name="([^"]+)"/i)?.[1]
  const type = tag.match(/type="([^"]+)"/i)?.[1] || 'text'
  if (name) console.log(`  [${type}] ${name}`)
}

console.log('\ncookies:', jar.names().join(', ') || '(inga)')
console.log('\nHTML-utdrag:', r.body.replace(/\s+/g, ' ').slice(0, 600))

// Fortsätt ett steg: skicka oauth_token till Mentor och se om vi når
// inloggningsformuläret (__VIEWSTATE + användar-/lösenordsfält).
const oauth = r.body.match(/name="oauth_token"\s+value="([^"]*)"/)?.[1]
if (oauth) {
  console.log('\n[2] POST oauth_token → mentor/ (utan konto) …')
  const r2 = await follow(jar, 'https://infomentor.se/swedish/production/mentor/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ oauth_token: oauth }).toString(),
  })
  console.log('slutlig URL :', r2.url)
  console.log('__VIEWSTATE :', /__VIEWSTATE/.test(r2.body))
  console.log('formulärfält:')
  for (const tag of [...r2.body.matchAll(/<input\b[^>]*>/gi)].map((m) => m[0])) {
    const name = tag.match(/name="([^"]+)"/i)?.[1]
    const type = tag.match(/type="([^"]+)"/i)?.[1] || 'text'
    if (name) console.log(`  [${type}] ${name}`)
  }
}
