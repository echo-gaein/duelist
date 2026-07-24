# DueList

A Chrome extension that detects homework assignments on course pages and adds
them to **Google Tasks** — deduplicated, so re-scanning never creates the same
task twice. **No backend, no server to run:** it authenticates with Chrome's
built-in `chrome.identity` and calls the Google Tasks API directly.

> **Note:** DueList adds to **Google Tasks**, which store a *date only* (no time
> of day). See [Known limitations](#known-limitations).

## How it works

1. Open DueList on a supported course page and click **Scan**.
2. Review the detected assignments and select the ones you want to add.
3. Click **Add Selected** to create Google Tasks.

DueList uses Chrome's Google sign-in flow. It does not ask for your Google
password or run a separate server.

## Supported sites

| Site | What DueList looks for |
| --- | --- |
| Gradescope (`*.gradescope.com`) | Upcoming assignments that have not been submitted or graded. |
| Canvas / bCourses (`bcourses.berkeley.edu`, `*.instructure.com`) | Assignments with visible due dates, excluding items that clearly look submitted or graded. |
| Pensive (`*.pensive.com`) | Assignment-like items with due dates, excluding items marked submitted. |

## Setup

1. Open `chrome://extensions`, enable **Developer mode**.
2. Click **Load unpacked** and select the [`frontend/`](frontend) folder.
3. Open a supported course page.
4. Open DueList and click **Connect Google**.

If the Google consent screen blocks access, the app is still in development and
your Google account may not be approved for the current test version yet.

## Usage

1. Navigate to a supported course page (e.g. a Gradescope course dashboard).
2. Open the popup and click **Scan**. Detected assignments appear with their
   course, due date, and source, plus a relative hint ("in 3 days", "2 days
   ago"). Anything past its deadline gets a red **Late** badge; ones already in
   Google Tasks are badged **Added** and can't be re-added. Anything the
   detector isn't sure it parsed correctly gets an amber **⚠ Check** badge (with
   the confidence % on hover) — double-check its date and title before adding.
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

## Known limitations

- **Date only, no time.** Google Tasks can't store a time of day, so an
  11:59 PM deadline becomes a task due on that date. Preserving times would
  require Google Calendar support.
- **Chrome sign-in.** DueList uses the Google account signed into Chrome.
- **A few sites.** Only Gradescope, Canvas/bCourses, and Pensive are wired up;
  other pages report "Unsupported site."
- **Round-hour Canvas times.** Canvas deadlines with a time like "5pm" (no
  minutes) aren't parsed yet; "11:59pm"-style times work.
- **Heuristic scraping.** Detection depends on page structure and can miss or
  misparse assignments when a site changes its markup. The **⚠ Check**
  confidence flag is itself a heuristic — treat it as a nudge to verify, not a
  guarantee either way.
- **Course names.** Taken from the page header when possible; if the page title
  is too generic, DueList may fall back to the course name in the URL.
- **De-dup by name + date.** An assignment is "already added" if a task with a
  matching due date has the same name — with or without a `Class:` prefix — so
  adding a class name doesn't lose the added state. Two genuinely different
  assignments with the same name and due date could still collide.
