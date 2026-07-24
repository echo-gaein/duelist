(function registerDetectors(global) {
  const SOURCE_GRADESCOPE = "Gradescope";
  const SOURCE_PENSIVE = "Pensive";
  const SOURCE_CANVAS = "Canvas";
  const SOURCE_GENERIC = "Detected page";
  const CANVAS_DOMAINS = ["bcourses.berkeley.edu", "instructure.com"];

  const SITE_DETECTORS = [
    {
      id: "gradescope",
      name: SOURCE_GRADESCOPE,
      domains: ["gradescope.com"],
      matches: (hostname) => matchesSiteDomain(hostname, ["gradescope.com"]),
      detect: ({ document, url }) => detectGradescope(document, url),
    },
    {
      id: "canvas",
      name: SOURCE_CANVAS,
      domains: CANVAS_DOMAINS,
      matches: (hostname) => matchesSiteDomain(hostname, CANVAS_DOMAINS),
      detect: ({ document, url }) => detectCanvas(document, url),
    },
    {
      id: "pensive",
      name: SOURCE_PENSIVE,
      domains: ["pensive.com"],
      matches: (hostname) =>
        matchesSiteDomain(hostname, ["pensive.com"]),
      detect: ({ document, url }) => detectPensive(document, url),
    },
  ];

  function detectAssignments({ document, location }) {
    const url = location.href;
    const hostname = location.hostname.toLowerCase();
    const site = SITE_DETECTORS.find((detector) => detector.matches(hostname));
    if (!site) return [];

    const assignments = site.detect({ document, location, url });

    return dedupe(assignments)
      .filter((assignment) => assignment.title && assignment.dueAt)
      .map((assignment) => ({ ...assignment, dueDate: localDateString(assignment.dueAt) }))
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  }

  // The calendar date of dueAt in this browser's timezone (YYYY-MM-DD). Google
  // Tasks stores date-only due values, so preserving the local day prevents
  // timezone drift when the task is created.
  function localDateString(dueAt) {
    const date = new Date(dueAt);
    if (Number.isNaN(date.getTime())) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function detectGradescope(document, url) {
    const course = textOf(
      document.querySelector(".courseHeader--title") ||
        document.querySelector("h1") ||
        document.querySelector("[data-course-name]"),
    );
    const defaultYear = inferGradescopeYear(document) || new Date().getFullYear();
    const rowAssignments = [];
    const candidates = [
      ...document.querySelectorAll("tr"),
      ...document.querySelectorAll("[role='row']"),
      ...document.querySelectorAll(".assignment"),
      ...document.querySelectorAll("[class*='assignment']"),
    ];

    for (const element of candidates) {
      const text = normalizeWhitespace(element.innerText || element.textContent || "");
      if (!text || !hasMonthName(text)) continue;

      const title = gradescopeTitleForElement(element, text);
      const rawDueText = extractGradescopeDueText(element, text);
      const dueAt = parseDueDate(rawDueText || text, { defaultYear });

      if (!title || !dueAt) continue;

      // Only surface assignments the student still needs to turn in. Skip rows
      // that are already submitted or graded; keep "No Submission", late, and
      // rows whose status can't be determined.
      if (isSubmittedOrGraded(element)) continue;

      rowAssignments.push({
        title: cleanupTitle(title),
        course: cleanupCourse(course),
        dueAt,
        rawDueText,
        source: SOURCE_GRADESCOPE,
        url: findBestUrl(element, url),
      });
    }

    const rows = dedupe(rowAssignments);
    if (rows.length) return rows;

    const links = dedupe(
      detectGradescopeFromAssignmentLinks(document, url, course, defaultYear),
    );
    if (links.length) return links;

    return dedupe(detectGradescopeFromPageText(document, url, course, defaultYear));
  }

  function detectGradescopeFromAssignmentLinks(document, url, course, defaultYear) {
    const assignments = [];
    const bodyLines = pageLines(document);
    const anchors = [...document.querySelectorAll("a[href]")].filter((anchor) => {
      const href = anchor.getAttribute("href") || "";
      return /\/courses\/\d+\/assignments\/\d+/.test(href);
    });

    for (const anchor of anchors) {
      const title = cleanupTitle(textOf(anchor));
      if (!title) continue;

      const linkUrl = absoluteUrl(anchor.getAttribute("href"), url);
      const anchorContext = contextForAnchor(anchor);
      const textContext = contextForTitle(bodyLines, title);
      const rawDueText =
        preferGradescopeDueFromText(anchorContext) ||
        preferGradescopeDueFromText(textContext);
      const dueAt = parseDueDate(rawDueText, { defaultYear });

      if (!dueAt) continue;

      assignments.push({
        title,
        course: cleanupCourse(course),
        dueAt,
        rawDueText,
        source: SOURCE_GRADESCOPE,
        url: linkUrl,
      });
    }

    return assignments;
  }

  function detectGradescopeFromPageText(document, url, course, defaultYear) {
    const assignments = [];
    const lines = pageLines(document);
    const titlePattern = /^(?:homework|hw|lab|project|quiz|exam|hog|checkpoint|discussion|worksheet|vitamin)\b/i;

    for (let index = 0; index < lines.length; index += 1) {
      const title = cleanupTitle(lines[index]);
      if (!titlePattern.test(title)) continue;

      const context = lines.slice(index, index + 12).join("\n");
      const rawDueText = preferGradescopeDueFromText(context);
      const dueAt = parseDueDate(rawDueText, { defaultYear });
      if (!dueAt) continue;

      assignments.push({
        title,
        course: cleanupCourse(course),
        dueAt,
        rawDueText,
        source: SOURCE_GRADESCOPE,
        url,
      });
    }

    return assignments;
  }

  function detectPensive(document, url) {
    return detectGeneric(document, url, {
      source: SOURCE_PENSIVE,
      dueTextExtractor: preferPrimaryDueDateBeforeLate,
    });
  }

  function detectCanvas(document, url) {
    // Berkeley's bCourses is a Canvas instance; label it accordingly.
    const source = /bcourses\.berkeley\.edu/i.test(url) ? "bCourses" : SOURCE_CANVAS;
    const course = inferCourseName(document, url);
    const defaultYear = inferPageYear(document) || new Date().getFullYear();
    const assignments = [];

    // Canvas assignment-index rows. The name lives in an `.ig-title` link and
    // the deadline in an `.assignment-date-due` element.
    const rows = [...document.querySelectorAll("li.ig-row"), ...document.querySelectorAll("li.assignment")];

    for (const row of rows) {
      const titleLink =
        row.querySelector("a.ig-title") ||
        row.querySelector(".ig-title") ||
        row.querySelector("a[href*='/assignments/']");
      if (!titleLink) continue;

      const title = cleanupTitle(getAttr(titleLink, "title") || textOf(titleLink));
      if (!title) continue;

      const dueEl =
        row.querySelector(".assignment-date-due") ||
        row.querySelector("[class*='date-due']") ||
        row.querySelector(".ig-details");
      const rowText = textOf(row);
      const rawDueText = canvasDueText(dueEl) || extractDueText(rowText);
      const dueAt = parseDueDate(rawDueText || rowText, { defaultYear });
      if (!dueAt) continue;

      // Canvas has no status column: unsubmitted work simply shows a due date.
      // Skip only rows that explicitly say they were submitted/graded.
      if (looksSubmittedOrGraded(rowText)) continue;

      assignments.push({
        title,
        course: cleanupCourse(course),
        dueAt,
        rawDueText,
        source,
        url: absoluteUrl(getAttr(titleLink, "href") || "", url),
      });
    }

    const rows_ = dedupe(assignments);
    if (rows_.length) return rows_;

    // Fall back to the generic heuristic detector for other Canvas pages.
    return detectGeneric(document, url, { source });
  }

  function canvasDueText(element) {
    if (!element) return "";
    const text = normalizeWhitespace(element.innerText || element.textContent || "");
    if (!text) return "";
    const dueMatch = text.match(/\bdue\b\s*:?\s*(.+)$/i);
    return dueMatch ? dueMatch[1].trim() : text;
  }

  // Conservative, text-based "already turned in" check shared by the Canvas and
  // generic (Pensive) detectors. Guards against "no submission"/"not submitted"
  // so unsubmitted work is never dropped.
  function looksSubmittedOrGraded(text) {
    const value = normalizeWhitespace(text);
    if (/\b(no submission|not submitted|unsubmitted|missing)\b/i.test(value)) return false;
    return /\bsubmitted\b/i.test(value) || /\bturned in\b/i.test(value);
  }

  function getAttr(element, name) {
    return element && element.getAttribute ? element.getAttribute(name) : null;
  }

  function detectGeneric(document, url, options = {}) {
    const course = inferCourseName(document, url);
    const defaultYear = inferPageYear(document) || new Date().getFullYear();
    const source = options.source || sourceFromUrl(url) || SOURCE_GENERIC;
    const dueTextExtractor = options.dueTextExtractor || preferPrimaryDueDateBeforeLate;
    const assignments = [];
    const selectors = [
      "li",
      "tr",
      "article",
      "section",
      "[class*='assignment']",
      "[class*='homework']",
      "[class*='project']",
      "[class*='lab']",
      "[class*='deadline']",
      "[class*='due']",
    ];
    const candidates = [...document.querySelectorAll(selectors.join(","))];

    for (const element of candidates) {
      if (element.closest("nav, header, footer, script, style")) continue;

      const text = normalizeWhitespace(element.innerText || element.textContent || "");
      if (text.length < 12 || text.length > 800) continue;
      if (!looksLikeAssignmentText(text) || !looksLikeDueText(text)) continue;
      // Only surface work the student still needs to turn in.
      if (looksSubmittedOrGraded(text)) continue;

      const rawDueText = dueTextExtractor(text) || extractDueText(text);
      const dueAt = parseDueDate(rawDueText || text, { defaultYear });
      if (!dueAt) continue;

      const title = inferTitle(element, text);
      if (!title || title.length < 3) continue;

      assignments.push({
        title: cleanupTitle(title),
        course,
        dueAt,
        rawDueText,
        source,
        url: findBestUrl(element, url),
      });
    }

    return assignments;
  }

  function inferCourseName(document, url) {
    const selectors = [
      "[data-course-name]",
      ".course-title",
      ".courseHeader--title",
      "#breadcrumbs .ellipsible",
      ".ic-app-course-menu .ellipsible",
      "nav[aria-label='breadcrumb'] a",
      "h1",
      "title",
    ];

    for (const selector of selectors) {
      const value =
        selector === "title"
          ? document.title
          : textOf(document.querySelector(selector));
      const cleaned = cleanupCourse(value);
      // Skip generic page names like "Assignments" or "Dashboard".
      if (cleaned && !isGenericCourseName(cleaned)) return cleaned;
    }

    // Last resort: pull the class/course slug out of the URL, e.g.
    // /classes/data8_su26/ -> "Data8 Su26". Numeric ids (Canvas) are skipped.
    return courseFromUrl(url);
  }

  function isGenericCourseName(name) {
    return /^(assignments?|my assignments?|dashboard|home|courses?|to-?do( list)?|calendar|grades?|modules?|syllabus|inbox|account|announcements?)$/i.test(
      normalizeWhitespace(name),
    );
  }

  function courseFromUrl(url) {
    try {
      const path = new URL(url).pathname;
      const match = path.match(/\/(?:classes|class|courses|course)\/([^/]+)/i);
      if (!match) return "";
      const slug = decodeURIComponent(match[1]);
      if (/^\d+$/.test(slug)) return "";

      // Drop term tokens (su26, fa2025, summer, 2026…) so only the course
      // remains, then tidy: "data8_su26" -> "Data 8".
      const tokens = slug.split(/[_-]+/).filter(Boolean);
      const courseTokens = tokens.filter((token) => !isTermToken(token));
      const kept = (courseTokens.length ? courseTokens : tokens).join(" ");

      return kept
        .replace(/([a-zA-Z])(\d)/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
        .slice(0, 80);
    } catch (_error) {
      return "";
    }
  }

  function isTermToken(token) {
    return (
      /^(sp|su|fa|wi|spring|summer|fall|winter|autumn)\d{2,4}$/i.test(token) ||
      /^\d{2,4}(sp|su|fa|wi|spring|summer|fall|winter|autumn)$/i.test(token) ||
      /^(spring|summer|fall|winter|autumn)$/i.test(token) ||
      /^20\d{2}$/.test(token)
    );
  }

  function inferPageYear(document) {
    const text = [
      document.title,
      textOf(document.querySelector("h1")),
      textOf(document.querySelector(".courseHeader--term")),
      textOf(document.querySelector(".courseHeader--title")),
      document.body?.innerText || document.body?.textContent || "",
    ].join("\n");

    const termYear = text.match(/\b(?:spring|summer|fall|winter)\s+(20\d{2})\b/i);
    if (termYear) return Number(termYear[1]);

    const standaloneYear = text.match(/\b(20\d{2})\b/);
    if (standaloneYear) return Number(standaloneYear[1]);

    return null;
  }

  function inferTitle(element, text) {
    const selectors = [
      "h1",
      "h2",
      "h3",
      "h4",
      "a",
      "strong",
      "[class*='title']",
      "[class*='name']",
    ];

    for (const selector of selectors) {
      const value = textOf(element.querySelector(selector));
      if (value && !looksLikeDueText(value)) return value;
    }

    const line = firstUsefulLine(text);
    return line.replace(/\b(due|deadline)\b.*$/i, "").trim() || line;
  }

  function parseDueDate(text, options = {}) {
    if (!text) return null;

    const defaultYear = options.defaultYear || new Date().getFullYear();
    const candidates = dateCandidates(text);
    for (const candidate of candidates) {
      const normalized = normalizeDateText(candidate, defaultYear);
      const timestamp = Date.parse(normalized);
      if (!Number.isNaN(timestamp)) {
        const date = new Date(timestamp);
        if (isReasonableDueDate(date, defaultYear)) return date.toISOString();
      }
    }

    return null;
  }

  function dateCandidates(text) {
    const compact = normalizeWhitespace(text);
    const patterns = [
      /\b(?:late\s+)?due(?:\s+date)?\s*:?\s*([^|•\n]+?)(?=\s{2,}|$)/gi,
      /\b(?:deadline|closes?|ends?|available until)\s*:?\s*([^|•\n]+?)(?=\s{2,}|$)/gi,
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?(?:\s+(?:at|by)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi,
      /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+(?:at|by)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi,
      /\b\d{4}-\d{2}-\d{2}(?:[ t]\d{1,2}:\d{2}(?::\d{2})?)?/gi,
    ];

    const matches = [];
    for (const pattern of patterns) {
      for (const match of compact.matchAll(pattern)) {
        matches.push(match[1] || match[0]);
      }
    }

    return matches.length ? matches : [compact];
  }

  function normalizeDateText(text, defaultYear = new Date().getFullYear()) {
    let value = normalizeWhitespace(text)
      .replace(/\blate\s+due\s+date\s*:?\s*/gi, "")
      .replace(/\bdue\s+date\s*:?\s*/gi, "")
      .replace(/\bdue\s*:?\s*/gi, "")
      .replace(/\b(deadline|closes?|ends?|available until)\s*:?\s*/gi, "")
      .replace(/(\d)(am|pm)\b/gi, "$1 $2")
      .replace(/\b(today|tomorrow|yesterday)\b/gi, (match) => {
        const date = new Date();
        if (/tomorrow/i.test(match)) date.setDate(date.getDate() + 1);
        if (/yesterday/i.test(match)) date.setDate(date.getDate() - 1);
        return date.toLocaleDateString();
      })
      .replace(/\b(at|by)\b/gi, " ")
      .replace(/\b(end of day|midnight)\b/gi, "11:59 PM")
      .replace(/\s+/g, " ")
      .trim();

    if (!/\b\d{4}\b/.test(value) && hasMonthName(value)) {
      value = `${value} ${defaultYear}`;
    }

    if (!/\b(am|pm)\b/i.test(value) && /\b11:59\b/.test(value)) {
      value = value.replace(/\b11:59\b/, "11:59 PM");
    }

    return value;
  }

  function isReasonableDueDate(date, defaultYear = new Date().getFullYear()) {
    const year = date.getFullYear();
    return year >= defaultYear - 1 && year <= defaultYear + 5;
  }

  function extractDueText(text) {
    const compact = normalizeWhitespace(text);
    const match = compact.match(
      /\b(?:(?:late\s+)?due(?:\s+date)?|deadline|closes?|ends?|available until)\s*:?\s*([^•|]+?)(?=\s{2,}|$)/i,
    );
    return match ? match[0].trim() : "";
  }

  function extractGradescopeDueText(element, text) {
    const cells = [...element.querySelectorAll("td, th")].map((cell) =>
      normalizeWhitespace(cell.innerText || cell.textContent || ""),
    );

    const dueCells = cells.filter(
      (cell) =>
        cell &&
        cell !== textOf(element.querySelector("a")) &&
        (/\b(late\s+)?due\s+date\b/i.test(cell) ||
          /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\s+at\s+\d{1,2}/i.test(
            cell,
          )),
    );
    const dueCell = dueCells.at(-1);

    return preferGradescopePrimaryDueDate(dueCell || text);
  }

  function inferGradescopeYear(document) {
    return inferPageYear(document);
  }

  function isSubmittedOrGraded(element) {
    const status = gradescopeSubmissionStatus(element);
    return status === "submitted" || status === "graded";
  }

  function gradescopeSubmissionStatus(element) {
    for (const cell of [...element.querySelectorAll("td, th")]) {
      // Skip the assignment-title cell so a title like "Reading 1/2" can't be
      // read as a score, and skip date/deadline cells for the same reason. When
      // in doubt this errs toward "unknown" (included) rather than dropping.
      if (findAssignmentAnchor(cell)) continue;

      const text = normalizeWhitespace(cell.innerText || cell.textContent || "");
      if (!text || hasMonthName(text) || /\b(due|left|released|ago)\b/i.test(text)) continue;

      if (/no submission/i.test(text)) return "no_submission";
      if (/^(submitted|ungraded|processing)\b/i.test(text)) return "submitted";
      // A cell that leads with a score like "8.0 / 10.0" means it is turned in.
      if (/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\b/.test(text)) return "graded";
    }

    return "unknown";
  }

  function gradescopeTitleForElement(element, text) {
    // Gradescope always puts the assignment name in the row's primary-link
    // header cell. Trust it directly — real names like "Ants", "Cats", or
    // "Scheme" don't start with a keyword such as "Homework" or "Lab".
    const primaryTitle = textOf(element.querySelector(".table--primaryLink"));
    if (primaryTitle) return primaryTitle;

    const assignmentAnchor = findAssignmentAnchor(element);
    if (assignmentAnchor) return textOf(assignmentAnchor);

    const title = firstUsefulLine(text);
    return looksLikeGradescopeAssignmentTitle(title) ? title : "";
  }

  function findAssignmentAnchor(element) {
    const anchors = [...element.querySelectorAll("a[href]")];
    return (
      anchors.find((anchor) =>
        /\/courses\/\d+\/assignments\/\d+/.test(anchor.getAttribute("href") || ""),
      ) ||
      anchors.find((anchor) => looksLikeGradescopeAssignmentTitle(textOf(anchor))) ||
      null
    );
  }

  function looksLikeGradescopeAssignmentTitle(title) {
    return /^(?:homework|hw|lab|project|quiz|exam|hog|checkpoint|discussion|worksheet|vitamin)\b/i.test(
      cleanupTitle(title),
    );
  }

  function preferGradescopePrimaryDueDate(text) {
    const lines = String(text)
      .split(/\r?\n/)
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);
    const lateDueIndex = lines.findIndex((line) => /\blate\s+due\s+date\b/i.test(line));
    const primaryLines = lateDueIndex === -1 ? lines : lines.slice(0, lateDueIndex);
    const primaryDates = primaryLines.flatMap((line) => monthDateMatches(line));

    if (primaryDates.length) return primaryDates.at(-1);
    return preferPrimaryDueDate(text);
  }

  function preferPrimaryDueDate(text) {
    const compact = normalizeWhitespace(text);
    const beforeLateDueDate = compact.split(/\blate\s+due\s+date\b/i)[0];
    const primaryDateMatches = beforeLateDueDate.match(
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?(?:\s+(?:at|by)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi,
    );

    if (primaryDateMatches && primaryDateMatches.length) {
      return primaryDateMatches.at(-1);
    }

    const dueDateMatch = compact.match(
      /\bdue\s+date\s*:?\s*((?!late\s+due\s+date).+?)(?=\blate\s+due\s+date\b|$)/i,
    );
    if (dueDateMatch) return dueDateMatch[1].trim();

    const anyDateMatches = compact.match(
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?(?:\s+(?:at|by)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi,
    );

    if (anyDateMatches && anyDateMatches.length) {
      return anyDateMatches.at(-1);
    }

    return extractDueText(compact) || compact;
  }

  function preferPrimaryDueDateBeforeLate(text) {
    const beforeLateDueDate = normalizeWhitespace(text).split(/\blate\s+due\s+date\b/i)[0];

    const explicitDue = beforeLateDueDate.match(
      /\bdue\s+date\s*:?\s*([^]+?)$/i,
    );
    if (explicitDue) {
      const explicitDates = monthDateMatches(explicitDue[1]);
      if (explicitDates.length) return explicitDates.at(-1);
    }

    const dates = monthDateMatches(beforeLateDueDate);
    return dates.length ? dates.at(-1) : "";
  }

  function preferGradescopeDueFromText(text) {
    const compact = normalizeWhitespace(text);
    if (!compact) return "";

    const explicitDue = compact.match(
      /\bdue\s+date\s*:?\s*([^]+?)(?=\blate\s+due\s+date\b|$)/i,
    );
    if (explicitDue) return preferGradescopePrimaryDueDate(explicitDue[1]);

    const beforeLateDueDate = compact.split(/\blate\s+due\s+date\b/i)[0];
    const dates = monthDateMatches(beforeLateDueDate);

    if (!dates || !dates.length) return "";
    return dates.length >= 2 ? dates[1] : dates[0];
  }

  function monthDateMatches(text) {
    return (
      normalizeWhitespace(text).match(
        /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,\s*\d{4})?(?:\s+(?:at|by)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi,
      ) || []
    );
  }

  function looksLikeAssignmentText(text) {
    return /\b(assignment|homework|hw|project|lab|problem set|pset|quiz|exam|deliverable)\b/i.test(
      text,
    );
  }

  function looksLikeDueText(text) {
    return (
      /\b(due|deadline|closes?|ends?|available until)\b/i.test(text) &&
      (hasMonthName(text) ||
        /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(text) ||
        /\b\d{4}-\d{2}-\d{2}\b/.test(text) ||
        /\b(today|tomorrow)\b/i.test(text))
    );
  }

  function hasMonthName(text) {
    return /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\b/i.test(
      text,
    );
  }

  function firstUsefulLine(text) {
    const lines = String(text)
      .split(/\n| {2,}/)
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);

    return (
      lines.find((line) => !looksLikeDueText(line) && line.length <= 120) ||
      lines[0] ||
      ""
    );
  }

  function cleanupTitle(title) {
    return normalizeWhitespace(title)
      .replace(/\b(submit|view|open|details)\b$/i, "")
      .replace(/\s+-\s+due\b.*$/i, "")
      .trim()
      .slice(0, 160);
  }

  function cleanupCourse(course) {
    return normalizeWhitespace(course)
      .replace(/\s*\|\s*.*$/, "")
      .replace(/\s+-\s*Gradescope\s*$/i, "")
      .trim()
      .slice(0, 80);
  }

  function sourceFromUrl(url) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      if (!hostname) return "";
      return hostname
        .split(".")
        .slice(0, -1)
        .join(".")
        .replace(/(^|-)([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
    } catch (_error) {
      return "";
    }
  }

  function matchesSiteDomain(hostname, domains) {
    const normalizedHostname = String(hostname || "").toLowerCase();
    return domains.some((domain) => {
      const normalizedDomain = domain.toLowerCase();
      return (
        normalizedHostname === normalizedDomain ||
        normalizedHostname.endsWith(`.${normalizedDomain}`)
      );
    });
  }

  function findBestUrl(element, fallbackUrl) {
    const link = element.querySelector("a[href]");
    if (!link) return fallbackUrl;

    try {
      return new URL(link.getAttribute("href"), fallbackUrl).href;
    } catch (_error) {
      return fallbackUrl;
    }
  }

  function absoluteUrl(href, fallbackUrl) {
    try {
      return new URL(href, fallbackUrl).href;
    } catch (_error) {
      return fallbackUrl;
    }
  }

  function contextForAnchor(anchor) {
    const containers = [
      anchor.closest("tr"),
      anchor.closest("[role='row']"),
      anchor.closest("li"),
      anchor.closest("article"),
      anchor.closest("section"),
      anchor.parentElement,
      anchor.parentElement?.parentElement,
      anchor.parentElement?.parentElement?.parentElement,
    ].filter(Boolean);

    for (const container of containers) {
      const text = normalizeWhitespace(container.innerText || container.textContent || "");
      if (hasMonthName(text) && text.length < 1200) return text;
    }

    return "";
  }

  function contextForTitle(lines, title) {
    const normalizedTitle = normalizeWhitespace(title).toLowerCase();
    const index = lines.findIndex(
      (line) => normalizeWhitespace(line).toLowerCase() === normalizedTitle,
    );
    if (index === -1) return "";
    return lines.slice(index, index + 12).join("\n");
  }

  function pageLines(document) {
    return String(document.body?.innerText || document.body?.textContent || "")
      .split(/\r?\n/)
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);
  }

  function textOf(element) {
    if (!element) return "";
    return normalizeWhitespace(element.innerText || element.textContent || "");
  }

  function normalizeWhitespace(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .trim();
  }

  function dedupe(assignments) {
    const seen = new Set();
    const output = [];

    for (const assignment of assignments) {
      const key = [
        assignment.source,
        assignment.course,
        assignment.title,
        assignment.dueAt,
      ]
        .join("|")
        .toLowerCase();

      if (seen.has(key)) continue;
      seen.add(key);
      output.push(assignment);
    }

    return output;
  }

  global.AssignmentCalendarDetectors = {
    detectAssignments,
    debugPage,
    parseDueDate,
    siteDetectors: SITE_DETECTORS.map(({ id, name }) => ({ id, name })),
  };

  function debugPage({ document, location }) {
    const lines = pageLines(document);
    const links = [...document.querySelectorAll("a[href]")]
      .map((anchor) => ({
        text: textOf(anchor),
        href: anchor.getAttribute("href") || "",
      }))
      .filter((link) => /assignment|\/assignments\//i.test(`${link.text} ${link.href}`))
      .slice(0, 12);

    return {
      hostname: location.hostname,
      title: document.title,
      supportedSites: SITE_DETECTORS.map(({ id, name, domains }) => ({
        id,
        name,
        domains,
      })),
      matchedSite:
        SITE_DETECTORS.find((detector) =>
          detector.matches(location.hostname.toLowerCase()),
        )?.name || null,
      lineCount: lines.length,
      sampleLines: lines.slice(0, 30),
      assignmentLinks: links,
    };
  }
})(window);
