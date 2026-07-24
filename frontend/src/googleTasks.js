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

  // Fingerprint -> task, across all pages of the default list.
  async function listAssignmentTasks(options = {}) {
    const index = new Map();
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
        if (!task.title) continue;
        const key = taskKey(task.title, task.due);
        if (!index.has(key)) index.set(key, task);
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);

    return index;
  }

  async function upsertAssignmentTask(assignment, index) {
    validateAssignment(assignment);
    const key = taskKey(taskTitle(assignment), taskDueDate(assignment));
    const existing = index.get(key);

    if (existing) {
      return {
        status: "skipped",
        key,
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
      key,
      taskId: created.id,
      taskLink: created.selfLink,
      assignment,
    };
  }

  // Add several assignments, listing existing tasks once for de-duplication.
  async function addAssignments(assignments) {
    const index = await listAssignmentTasks({ interactive: true });
    const results = [];
    for (const assignment of assignments) {
      const result = await upsertAssignmentTask(assignment, index);
      if (result.status === "created") {
        index.set(result.key, { id: result.taskId });
      }
      results.push(result);
    }
    return results;
  }

  async function checkAssignmentStatuses(assignments) {
    const index = await listAssignmentTasks({ interactive: false });
    const results = [];

    for (const assignment of assignments) {
      validateAssignment(assignment);
      const key = taskKey(taskTitle(assignment), taskDueDate(assignment));
      const existing = index.get(key);
      results.push({
        status: existing ? "already_added" : "not_added",
        key,
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

  // De-duplication key: a task is "the same assignment" if its title and due
  // date match. Keeps the notes free of any bookkeeping text.
  function taskKey(title, due) {
    const normalizedTitle = String(title || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    const dueDay = String(due || "").slice(0, 10);
    return `${normalizedTitle}|${dueDay}`;
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
    taskKey,
    taskDueDate,
  };
})(typeof window !== "undefined" ? window : globalThis);
