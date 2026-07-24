// Backend-less Google Tasks access for the extension.
//
// Authentication uses chrome.identity.getAuthToken, so there is no client
// secret and no local server: Chrome mints and refreshes the OAuth token for
// the user's signed-in Google account. All Tasks API calls go straight from the
// extension to https://tasks.googleapis.com. Duplicates are detected by matching
// a task's title and due date, so the notes stay clean (just URL + Deadline).
(function registerGoogleTasks(global) {
  const TASKS_BASE = "https://tasks.googleapis.com/tasks/v1";
  const TASKLIST_ID = "@default";

  // ---- OAuth token (chrome.identity) --------------------------------------

  function getToken(interactive) {
    return new Promise((resolve, reject) => {
      try {
        chrome.identity.getAuthToken({ interactive }, (token) => {
          const error = chrome.runtime.lastError;
          if (error || !token) {
            reject(new Error(error?.message || "Not signed in to Google."));
            return;
          }
          resolve(typeof token === "string" ? token : token.token);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function removeToken(token) {
    return new Promise((resolve) => {
      if (!token) {
        resolve();
        return;
      }
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
  }

  async function isAuthenticated() {
    try {
      await getToken(false);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async function signIn() {
    await getToken(true);
  }

  // ---- Tasks API ----------------------------------------------------------

  async function apiRequest(method, path, body, options = {}) {
    const interactive = Boolean(options.interactive);
    let token = await getToken(interactive);
    let response = await sendRequest(token);

    // A 401 usually means the cached token went stale; drop it and retry once.
    if (response.status === 401) {
      await removeToken(token);
      token = await getToken(interactive);
      response = await sendRequest(token);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        payload.error?.message || `Google Tasks request failed (${response.status}).`,
      );
    }
    return payload;

    function sendRequest(activeToken) {
      return fetch(`${TASKS_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${activeToken}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    }
  }

  // Existing tasks bucketed by due day, across all pages of the default list.
  async function listTasksByDueDay(options = {}) {
    const byDay = new Map();
    let pageToken = "";

    do {
      const params = new URLSearchParams({
        maxResults: "100",
        showCompleted: "true",
        showHidden: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);

      const data = await apiRequest(
        "GET",
        `/lists/${TASKLIST_ID}/tasks?${params}`,
        null,
        options,
      );

      for (const task of data.items || []) {
        if (!task.title || !task.due) continue;
        const day = String(task.due).slice(0, 10);
        const bucket = byDay.get(day) || [];
        bucket.push(task);
        byDay.set(day, bucket);
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);

    return byDay;
  }

  // Find a stored task that is the same assignment — same due day, and the same
  // name whether or not a "Class: " prefix was added. This keeps the "already
  // added" state even after the user types a class name.
  function findExistingTask(byDay, assignment) {
    const day = taskDueDate(assignment).slice(0, 10);
    const bucket = byDay.get(day) || [];
    return bucket.find((task) => titleMatches(task.title, assignment.title)) || null;
  }

  async function upsertAssignmentTask(assignment, byDay) {
    validateAssignment(assignment);
    const existing = findExistingTask(byDay, assignment);

    if (existing) {
      return {
        status: "skipped",
        taskId: existing.id,
        taskLink: existing.selfLink,
        assignment,
      };
    }

    const created = await apiRequest(
      "POST",
      `/lists/${TASKLIST_ID}/tasks`,
      buildGoogleTask(assignment),
      { interactive: true },
    );

    return {
      status: "created",
      taskId: created.id,
      taskLink: created.selfLink,
      assignment,
    };
  }

  // Add several assignments, listing existing tasks once for de-duplication.
  async function addAssignments(assignments) {
    const byDay = await listTasksByDueDay({ interactive: true });
    const results = [];
    for (const assignment of assignments) {
      const result = await upsertAssignmentTask(assignment, byDay);
      if (result.status === "created") {
        // Track it so later assignments in the same batch de-dup against it.
        const built = buildGoogleTask(assignment);
        const day = built.due.slice(0, 10);
        const bucket = byDay.get(day) || [];
        bucket.push({ id: result.taskId, title: built.title, due: built.due });
        byDay.set(day, bucket);
      }
      results.push(result);
    }
    return results;
  }

  async function checkAssignmentStatuses(assignments) {
    const byDay = await listTasksByDueDay({ interactive: false });
    const results = [];

    for (const assignment of assignments) {
      validateAssignment(assignment);
      const existing = findExistingTask(byDay, assignment);
      results.push({
        status: existing ? "already_added" : "not_added",
        taskId: existing?.id || null,
        taskLink: existing?.selfLink || null,
        assignment,
      });
    }

    return results;
  }

  // ---- Pure helpers -------------------------------------------------------

  function validateAssignment(assignment) {
    if (!assignment || typeof assignment !== "object") {
      throw new Error("Assignment must be an object.");
    }
    if (!assignment.title || typeof assignment.title !== "string") {
      throw new Error("Assignment is missing a title.");
    }
    if (!assignment.dueAt || Number.isNaN(Date.parse(assignment.dueAt))) {
      throw new Error(`Assignment "${assignment.title}" has an invalid dueAt value.`);
    }
  }

  function taskTitle(assignment) {
    return assignment.course
      ? `${assignment.course}: ${assignment.title}`
      : assignment.title;
  }

  function normalizeTitle(title) {
    return String(title || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  // Whether a stored task's title is this assignment's name — either exactly, or
  // with any "Class: " prefix in front. That's what lets the "already added"
  // check survive the user typing (or changing) a class name.
  function titleMatches(storedTitle, assignmentTitle) {
    const stored = normalizeTitle(storedTitle);
    const base = normalizeTitle(assignmentTitle);
    return Boolean(base) && (stored === base || stored.endsWith(`: ${base}`));
  }

  function buildGoogleTask(assignment) {
    const notesParts = [
      assignment.url ? `URL: ${assignment.url}` : null,
      `Deadline: ${formatDeadlineForNotes(assignment.dueAt)}`,
    ].filter(Boolean);

    return {
      title: taskTitle(assignment),
      notes: notesParts.join("\n"),
      due: taskDueDate(assignment),
    };
  }

  // Google Tasks stores a date only. Prefer the browser-local dueDate the
  // detector computed so the day cannot drift across timezones.
  function taskDueDate(assignment) {
    const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(assignment.dueDate || "")
      ? assignment.dueDate
      : localDateString(new Date(assignment.dueAt));
    return `${isoDate}T00:00:00.000Z`;
  }

  function localDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function formatDeadlineForNotes(dueAt) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(dueAt));
  }

  global.AssignmentTasks = {
    isAuthenticated,
    signIn,
    addAssignments,
    checkAssignmentStatuses,
    // Exposed for tests:
    buildGoogleTask,
    taskTitle,
    titleMatches,
    taskDueDate,
  };
})(typeof window !== "undefined" ? window : globalThis);
