# infomentor-api

Unofficial, dependency-free toolkit for reading **InfoMentor** (the Swedish
school platform, "Mentor" / "InfoMentor Hub") with a regular **email/password**
account — and turning it into a **nightly family report delivered by email**.

> ⚠️ **Not affiliated with InfoMentor.** For personal use with your own account.
> The endpoints are undocumented and can change without warning. Use at your own
> risk and respect the service's terms of use.

## What it does

- Logs in with an email/password **Mentor account** (no BankID), following the
  OAuth hand-off into a `hub.infomentor.se` session.
- Discovers the children (`pupils`) on the account and switches the selected one.
- Reads notifications, news, calendar, timetable and assignments.
- Downloads the school lunch menu from Mateo (optional).
- Builds an evening summary: tomorrow's school day (start–end), a PE/gym
  reminder, assignments due, calendar events, absence and lunch.
- Emails it as plain text **and** accessible HTML over any SMTP account.
- **Zero npm dependencies** — Node 18+ built-in `fetch`; email via Python's
  stdlib `smtplib`.

## Requirements

- **Node 18+** (tested on Node 22) — nothing to `npm install`.
- **Python 3** — only used to send email.

## Quickstart

```bash
git clone https://github.com/c14ym0re/infomentor-api.git
cd infomentor-api

cp credentials.json.example credentials.json   # your InfoMentor email + password
npm run flow        # shows where an unauthenticated client lands (sanity check)
npm run login       # verifies the login and creates a hub session
npm run probe       # dumps every endpoint it can find into out/
npm run collect     # collects everything, diffs, writes out/digest.txt
npm run report      # renders out/kvallsammanfattning.html
```

To email the report, add `smtp.json` (see below) and run `npm run mail`.

## Configuration

All local config lives next to the code and is **gitignored**. Only the
`.example` files are committed.

| File | Purpose |
|---|---|
| `credentials.json` | InfoMentor email + password |
| `names.json` | optional — map hub names to nicknames |
| `lunch.json` | optional — school-lunch unit (Mateo) |
| `smtp.json` | SMTP account for sending the report |

```jsonc
// credentials.json
{ "username": "you@example.com", "password": "…" }

// names.json — hub name ("Lastname, Firstname") → display name
{ "Lastname, Firstname": "Nickname" }

// lunch.json — from https://meny.mateo.se/<municipality>/<unitId>
{ "provider": "mateo", "unitId": "123", "school": "Your school" }

// smtp.json — Gmail/Google Workspace example (use an app password!)
{
  "host": "smtp.gmail.com", "port": 587,
  "username": "you@example.com", "password": "app-password",
  "from": "you@example.com", "to": ["you@example.com"]
}
```

SMTP needs an **app password**, not your account password. For Gmail/Workspace
create one at <https://myaccount.google.com/apppasswords> (requires 2-Step
Verification).

## Daily automation

`run-evening.sh` runs collect → report → mail and logs to `out/cron.log`.
Add it to cron (adjust the path):

```
0 18 * * * /path/to/infomentor-api/run-evening.sh
```

## How it works

```
src/infomentor.js   cookie jar, redirect handling, login(), hubPost()
src/collect.js      logs in, switches pupils, collects + diffs, writes out/digest.txt
src/report.js       renders out/kvallsammanfattning.html (email-safe, accessible)
src/send_mail.py    sends the report via SMTP (text + HTML alternative)
src/names.js        nickname mapping (names.json)
src/lunch.js        school lunch from Mateo (lunch.json)
src/login.js        verify login
src/probe.js        enumerate endpoints
src/probe-apps.js   probe task/uolv2/assessmentv2/documentation/…
src/flowcheck.js    unauthenticated flow diagnostics
src/switch-test.js  verify pupil switching
src/tasks-check.js  verify assignments follow the selected pupil
src/classlist-check.js / timetable-check.js / week-check.js   focused diagnostics
run-evening.sh      cron wrapper: collect → report → mail
```

### Login flow

```
GET  hub.infomentor.se                     → 302 → login page (oauth_token)
POST oauth_token        → mentor/          → login form (__VIEWSTATE)
POST username/password  + viewstate        → 302
POST oauth_token        → mentor/          → back to hub
POST …/isauthenticated                    → session established
```

The session lives in cookies (`ASP.NET_SessionId`, `BIGipServer~…`, `IMHome`).
Every run simply logs in again, so a dead session is never a problem.

Municipalities differ: some use BankID/SSO (`sso.infomentor.se/login.ashx?idp=…`),
others the email/password Mentor account used here. Which one works depends on
your school. If you use SSO, the same end state (hub cookies) is what you need.

## Discovered endpoints

All are `POST` to `https://hub.infomentor.se` with a JSON body (often `{}`),
after the session above.

| Area | Endpoint |
|---|---|
| Pupil list | parsed from the hub start page (`IMHome.pupils`) |
| Pupil switch | `GET /Account/PupilSwitcher/SwitchPupil/<id>` |
| Notifications | `/NotificationApp/NotificationApp/GetNotifications` |
| News | `/Communication/News/GetNewsList` |
| Calendar | `/calendarv2/calendarv2/getentries` (`{startDate,endDate}`) |
| Timetable | `/timetable/timetable/gettimetablelist` (`{start,end}`) |
| Assignments | `/task/task/GetTasks` |
| Attendance | `/attendance/attendance/appData` |
| Contacts | `/classlist/classlist/appData` (school staff) |
| Plan/assessments | `/uolv2/uolv2/appData`, `/assessmentv2/assessmentv2/appData` |

Notes:
- `/timetable/timetable/appData` **ignores** `startDate`/`endDate` and returns a
  rolling 5-day window — use `gettimetablelist` when you need a date range.
- A dead session answers `200` with an **empty body**; treat that as logged out.
- Notifications are aggregated across all children and mapped back to a pupil
  via `pupilSourceId`.

## Design & accessibility

The HTML report is built for real inboxes:

- **Inline styles only** (Gmail strips `<style>`/`<head>`), table-based layout
  with `role="presentation"`.
- **WCAG 2.2 AA contrast** with margin (primary `#1d1d1f`, secondary `#515154`,
  muted `#6e6e73`).
- 16–17 px body text, no italics, no thin weights.
- Light mode locked (`color-scheme: light only`) so dark mode can't wreck contrast.
- Under Gmail's 102 kB clipping limit.

## Credits

Built on the groundwork of the open-source Skolplattformen project:

- [`kolplattformen/skolplattformen`](https://github.com/kolplattformen/skolplattformen)
  (Apache-2.0) — `libs/api-infomentor`, endpoint documentation.
- [`kolplattformen/dementor.net`](https://github.com/kolplattformen/dementor.net)
  (MIT) — the email/password login flow.

## License

MIT © 2026 Claes Hall — see [LICENSE](LICENSE).
