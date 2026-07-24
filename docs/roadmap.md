# DueList Project Roadmap

DueList can grow from a useful class-page helper into a polished student
productivity project: a Chrome extension that detects assignments where students
already work, lets them review the results, and sends the final deadlines to the
tools they actually use.

The strongest long-term story is simple: DueList reduces the manual work of
tracking school obligations. It should become reliable enough that a student
trusts it, polished enough that another student can install it without help, and
well-tested enough that each new school platform feels maintainable.

## Current Starting Point

- Repository: `echo-gaein/duelist`.
- Shape: frontend-only Chrome extension.
- Core behavior: scans supported course pages and adds selected assignments to
  Google Tasks.
- Supported sites: Gradescope, Canvas/bCourses, and Pensive.
- Technical foundation: plain JavaScript, no build step, simple Node-based
  tests.

## Guiding Principles

1. Make the extension trustworthy before making it flashy. Deadline tools only
   matter if users believe the detected data is correct.
2. Keep the workflow fast: scan, review, edit if needed, add.
3. Treat each supported school platform as a maintained integration with tests,
   fixtures, and known limitations.
4. Document privacy clearly so users know what is read, where it goes, and what
   never leaves their browser.
5. Use GitHub like a real project: issues, branches, pull requests, milestones,
   releases, and automated checks.

## Branch Plan

Use `main` as the stable branch. Each meaningful change should happen on a
focused feature branch, then merge back after tests pass.

- `feature/repo-cleanup`: remove old backend files, clean documentation, and set
  up the repo structure.
- `feature/github-actions`: run tests automatically on every push and pull
  request.
- `feature/edit-before-add`: let users adjust title, course, due date, and
  destination before syncing.
- `feature/calendar-support`: add Google Calendar event creation and OAuth
  scopes.
- `feature/dashboard`: create a richer extension page for upcoming assignments.
- `fix/gradescope-parser` or `fix/canvas-parser`: keep parser bug fixes narrow
  and easy to review.

## Phase Roadmap

| Phase | Goal | High-value work |
| --- | --- | --- |
| Phase 1: Foundation | Make the repo clean and professional. | Remove unused backend, improve README, add docs, set up GitHub Actions. |
| Phase 2: Product polish | Make the extension easier to trust and use. | Editable review screen, better filters, selection states, local history, clearer error messages. |
| Phase 3: Calendar expansion | Solve the date-only limitation of Google Tasks. | Add Google Calendar support, preserve time-of-day, support task/calendar destination choice. |
| Phase 4: Detector growth | Support more platforms reliably. | Add Google Classroom, Moodle, Blackboard, Schoology, EdStem, PrairieLearn, and stronger fixture tests. |
| Phase 5: Dashboard | Turn collected assignments into an overview. | Upcoming timeline, course grouping, late items, priority sorting, search, manual entry. |
| Phase 6: Release readiness | Make it installable by others. | Chrome Web Store packaging, privacy policy, versioning, changelog, release checklist. |

## Major Feature Tracks

### Frontend-Only Product Cleanup

The first major progression is making the repo match the actual architecture.
Since the backend is not needed, the active project should stay frontend-only.
Useful historical notes can live in docs, but unused OAuth bridge code should
not stay in the main source tree.

- Keep setup instructions focused on `chrome.identity`.
- Keep the project layout simple: `frontend/`, `docs/`, and root test metadata.
- Keep secrets out of the repo.

### Review And Edit Before Adding

Detectors will never be perfect, so the product should let users correct details
before sending them to Google Tasks or Calendar.

- Editable title field.
- Editable course/class field.
- Editable due date and time when the destination supports time.
- Per-assignment destination choice: Tasks, Calendar, or both.
- Clear warning when a detected date is uncertain.

### Google Calendar Support

Google Calendar support is the best big technical milestone because it fixes
the current limitation that Google Tasks stores only a due date. Calendar events
can preserve times, reminders, and better weekly planning.

- Add the Calendar API scope and update OAuth setup documentation.
- Create events with start and end times when a page provides a time.
- Let users choose a target calendar.
- Add default reminders, such as one day before and one hour before.
- Keep duplicate detection for both tasks and events.

### More School Platforms

Adding more detectors turns DueList from a personal tool into a broader student
tool. The right way to do this is test-first: capture representative fixture
HTML, write tests, then implement the detector.

- Google Classroom.
- Moodle.
- Blackboard.
- Schoology.
- EdStem and PrairieLearn for CS classes.

### Dashboard View

A dashboard would make DueList feel like a complete app instead of only a popup.
It can start as an extension page that reads local extension storage.

- Upcoming assignments grouped by course.
- Week view showing workload density.
- Late and due-soon sections.
- Search and filters by source, course, date, and added status.
- Manual assignment entry for deadlines that cannot be scraped.

### Quality And Release Engineering

This is the work that makes the project impressive to future reviewers. A
polished GitHub repo with tests, issues, and releases tells a stronger story
than a big pile of features.

- Add GitHub Actions for `npm test`.
- Add linting and formatting.
- Consider TypeScript once the code grows past a few modules.
- Add version numbers and a changelog.
- Create release checklists for Chrome extension packaging.

## Next Three Moves

1. Finish `feature/repo-cleanup` and merge it back to `main`.
2. Add GitHub Actions so every push proves the existing tests still pass.
3. Design the next version of the popup around editable assignment review.
