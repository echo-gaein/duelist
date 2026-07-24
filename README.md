# DueList

A Chrome extension that detects homework assignments on course pages and adds
them to **Google Tasks** — deduplicated, so re-scanning never creates the same
task twice. **No backend, no server to run:** it authenticates with Chrome's
built-in `chrome.identity` and calls the Google Tasks API directly.

> **Note:** DueList adds to **Google Tasks**, which store a *date only* (no time
> of day). See [Known limitations](#known-limitations).

## How it works

```
┌──────────────────────┐    scan (on demand)     ┌──────────────────────┐
│  Chrome extension    │ ─ inject detectors.js ─▶ │  Course page DOM     │
│  popup.js            │ ◀─ assignments [] ────── │  (Gradescope/Canvas…)│
│  googleTasks.js      │                          └──────────────────────┘
└──────────┬───────────┘
           │  chrome.identity token  +  fetch (Bearer token)
           ▼
┌──────────────────────┐
│  Google Tasks API    │   https://tasks.googleapis.com
└──────────────────────┘
```

1. You open the popup on a supported course page and click **Scan**.
2. The popup injects `detectors.js` into the active tab (via `activeTab` +
   `scripting`) and scrapes assignment titles, due dates, and the course name.
3. `googleTasks.js` gets an OAuth token from Chrome, checks which assignments
   already exist, and adds the ones you select — talking straight to the Google
   Tasks API. Duplicates are detected by matching a task's **title and due
   date**, so each task's notes stay clean (just the URL and the deadline).

There is **no client secret** anywhere: Chrome mints and refreshes the token for
your signed-in Google account and keeps it in its own credential store.

## Supported sites

| Site | Detector |
| --- | --- |
| Gradescope (`*.gradescope.com`) | Structured table rows, with assignment-link and page-text fallbacks. Reads the title from the `.table--primaryLink` cell, prefers the primary due date over the "Late Due Date", and skips submitted/graded rows. |
| Canvas / bCourses (`bcourses.berkeley.edu`, `*.instructure.com`) | Assignment-index rows (`.ig-title` + `.assignment-date-due`), with a generic fallback. Canvas has no status column, so every assignment with a due date is included except ones that explicitly say they were submitted. |
| Pensive (`*.pensive.com`) | Generic heuristic detector (headings/rows/list items containing an assignment keyword + a due date). Skips items marked submitted. |

Adding a site means adding an entry to `SITE_DETECTORS` in
[`frontend/src/detectors.js`](frontend/src/detectors.js).

## Setup

You need a Google OAuth **client ID** (no secret) tied to the extension's ID.

### 1. Google Cloud

1. In the [Google Cloud Console](https://console.cloud.google.com/), create (or
   pick) a project and **enable the Google Tasks API**.
2. Configure the OAuth **consent screen** (External is fine) and add the Google
   accounts that will use this as **test users**.

### 2. Load the extension and get its ID

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the [`frontend/`](frontend) folder.
3. Copy the extension's **ID** shown on its card.

### 3. Create the OAuth client and wire it up

1. In Google Cloud → **Credentials → Create credentials → OAuth client ID**,
   choose application type **Chrome Extension** and paste the extension ID. No
   client secret is issued for this type.
2. Copy the **Client ID** and paste it into
   [`frontend/manifest.json`](frontend/manifest.json):
   ```json
   "oauth2": {
     "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
     "scopes": ["https://www.googleapis.com/auth/tasks"]
   }
   ```
3. Back on `chrome://extensions`, click **↻** to reload.
4. Open the popup and click **Connect Google** — Chrome shows the account/consent
   prompt, and you're done.

### Sharing it with other people

`chrome.identity` ties the OAuth client to the extension's ID, and an *unpacked*
extension's ID differs per machine. To make one build work for everyone:

- **Pin the ID** by adding a `"key"` to `manifest.json` (see
  [Chrome's docs](https://developer.chrome.com/docs/extensions/reference/manifest/key)),
  so every install shares the same ID — then the single OAuth client above works
  for all of them. Recipients just load the folder and click **Connect Google**.
- Or **publish** to the Chrome Web Store, which assigns a permanent ID.

Either way, each new user only needs to be added as a **test user** on your
consent screen (until the app is verified) — no backend, no config on their end.

## Usage

1. Navigate to a supported course page (e.g. a Gradescope course dashboard).
2. Open the popup and click **Scan**. Detected assignments appear with their
   course, due date, and source, plus a relative hint ("in 3 days", "2 days
   ago"). Anything past its deadline gets a red **Late** badge; ones already in
   Google Tasks are badged **Added** and can't be re-added.
3. Optionally type a course into the **Class name (optional)** box next to
   **Add Selected** — it prefixes every task you add, so titles read
   `<class>: <assignment>`. Leave it blank to use the detected course.
4. Select the ones you want and click **Add Selected**.

Only assignments you still need to turn in are scanned. On Gradescope, rows
marked **No Submission** (including late ones) are included; rows that are
already **Submitted** or that show a **score** are skipped.

Toggle **Hide late** in the results header to drop everything that's already
past due from the list (and from what gets added). The choice is remembered
between opens.

## Development & tests

No dependencies, no build step. Tests are plain Node scripts:

```bash
npm test
```

- [`frontend/tests/googleTasks.test.js`](frontend/tests/googleTasks.test.js) —
  fingerprint parity with SHA-256, timezone-safe due date, task building.
- [`frontend/tests/detectors.test.js`](frontend/tests/detectors.test.js) —
  Gradescope, Canvas, Pensive, and generic detector paths plus the local
  `dueDate` field, using a small hand-rolled DOM mock (no jsdom).

## Project layout

```
docs/
  roadmap.md           Project growth plan and future feature tracks
frontend/
  manifest.json        MV3 manifest (activeTab + scripting + identity; oauth2 client_id)
  popup.html/.css
  src/popup.js         Popup UI + scan/add flow
  src/googleTasks.js   chrome.identity auth + Google Tasks API (no secret, no server)
  src/detectors.js     DOM scraping heuristics (injected on demand)
  tests/
```

## Known limitations

- **Date only, no time.** Google Tasks can't store a time of day, so an
  11:59 PM deadline becomes a task due on that date. Preserving times would
  require the **Google Calendar** API (a different scope).
- **Chrome sign-in.** `chrome.identity` uses the Google account signed into
  Chrome. It's a Chromium-only API; a cross-browser build would use
  `launchWebAuthFlow` + PKCE instead.
- **A few sites.** Only Gradescope, Canvas/bCourses, and Pensive are wired up;
  other pages report "Unsupported site."
- **Round-hour Canvas times.** Canvas deadlines with a time like "5pm" (no
  minutes) aren't parsed yet; "11:59pm"-style times work.
- **Heuristic scraping.** Detection depends on page structure and can miss or
  misparse assignments when a site changes its markup.
- **Course names.** Taken from the page header when possible; when that's a
  generic label ("Assignments"), the class slug from the URL is used instead,
  with the term dropped (e.g. `/classes/data8_su26/` → "Data 8").
- **De-dup by title + date.** Two entries with the same task title and due date
  are treated as the same assignment — so an unrelated task you created yourself
  with an identical title and date could read as "already added."
