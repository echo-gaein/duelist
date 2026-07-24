const state = {
  assignments: [],
  selected: new Set(),
  hideLate: false,
};

const elements = {
  statusText: document.querySelector("#statusText"),
  actionsSection: document.querySelector("#actionsSection"),
  emptyState: document.querySelector("#emptyState"),
  resultsSection: document.querySelector("#resultsSection"),
  connectButton: document.querySelector("#connectButton"),
  scanButton: document.querySelector("#scanButton"),
  addButton: document.querySelector("#addButton"),
  resultCount: document.querySelector("#resultCount"),
  selectAllButton: document.querySelector("#selectAllButton"),
  hideLateToggle: document.querySelector("#hideLateToggle"),
  classNameInput: document.querySelector("#classNameInput"),
  assignmentList: document.querySelector("#assignmentList"),
  message: document.querySelector("#message"),
};

init();

async function init() {
  state.hideLate = localStorage.getItem("hideLate") === "1";
  elements.hideLateToggle.checked = state.hideLate;

  wireEvents();
  await refreshAuthStatus();
  await scanCurrentTab();
}

function wireEvents() {
  elements.connectButton.addEventListener("click", connectGoogleTasks);
  elements.scanButton.addEventListener("click", scanCurrentTab);
  elements.addButton.addEventListener("click", addSelectedAssignments);
  elements.selectAllButton.addEventListener("click", selectAllAssignments);
  elements.hideLateToggle.addEventListener("change", toggleHideLate);

  // The placeholder should vanish the moment the field is clicked into, and
  // return when it loses focus. Capture the original text once, up front.
  const classPlaceholder = elements.classNameInput.placeholder;
  elements.classNameInput.addEventListener("focus", () => {
    elements.classNameInput.placeholder = "";
  });
  elements.classNameInput.addEventListener("blur", () => {
    elements.classNameInput.placeholder = classPlaceholder;
  });
}

function classNameOverride() {
  return elements.classNameInput.value.trim();
}

// Apply the typed class name (if any) as the course, so the task title becomes
// "<class>: <assignment>". Empty input keeps the detected course.
function withCourseOverride(assignment) {
  const override = classNameOverride();
  return override ? { ...assignment, course: override } : assignment;
}

function toggleHideLate() {
  state.hideLate = elements.hideLateToggle.checked;
  localStorage.setItem("hideLate", state.hideLate ? "1" : "0");

  // Late assignments that just became hidden should leave the selection so they
  // aren't added.
  for (const index of [...state.selected]) {
    if (isHidden(state.assignments[index])) state.selected.delete(index);
  }
  renderAssignments();
}

async function refreshAuthStatus() {
  const authed = await AssignmentTasks.isAuthenticated();
  elements.statusText.textContent = authed
    ? "Google Tasks connected."
    : "Google Tasks not connected.";
  elements.connectButton.hidden = authed;
  // The class-name field only matters once you can add tasks.
  elements.classNameInput.hidden = !authed;
}

async function connectGoogleTasks() {
  showMessage("Connecting to Google...", "");
  setLoading(true);
  try {
    await AssignmentTasks.signIn();
    await refreshAuthStatus();
    if (state.assignments.length) await refreshAssignmentStatuses();
    renderAssignments();
    showMessage("Google Tasks connected.", "success");
  } catch (error) {
    showMessage(error.message || "Could not connect to Google.", "error");
  } finally {
    setLoading(false);
  }
}

async function scanCurrentTab() {
  showMessage("Scanning current page...", "");
  setLoading(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Could not find the active tab.");

    const response = await scanTab(tab.id);

    if (!response?.ok) {
      throw new Error(response?.error || "The content script could not scan this page.");
    }

    state.assignments = response.assignments || [];
    const isUnsupportedSite = Boolean(response.debug && !response.debug.matchedSite);
    setUnsupportedState(isUnsupportedSite);
    let checkedTaskStatus = true;
    if (state.assignments.length) {
      showMessage("Checking Google Tasks for existing items...", "");
      checkedTaskStatus = await refreshAssignmentStatuses();
    }
    state.selected = new Set(selectableIndexes());
    renderAssignments();

    const count = state.assignments.length;
    if (!count && response.debug) {
      console.info("DueList debug", response.debug);
    }

    if (isUnsupportedSite) {
      showMessage("", "");
    } else if (!count) {
      showMessage(emptyScanMessage(response.debug), "warning");
    } else {
      const lowCount = state.assignments.filter(isLowConfidence).length;
      const base = scanResultMessage(count, checkedTaskStatus);
      if (lowCount) {
        const verb = lowCount === 1 ? "looks" : "look";
        showMessage(
          `${base} ${lowCount} ${verb} uncertain — check the ⚠ marks.`,
          "warning",
        );
      } else {
        showMessage(base, checkedTaskStatus ? "success" : "warning");
      }
    }
  } catch (error) {
    showMessage(error.message || "Could not scan this page.", "error");
  } finally {
    setLoading(false);
  }
}

async function addSelectedAssignments() {
  const selectedIndexes = [...state.selected].filter(
    (index) => !isAlreadyAdded(state.assignments[index]),
  );

  if (!selectedIndexes.length) {
    showMessage("Select at least one assignment first.", "warning");
    return;
  }

  const payload = selectedIndexes.map((index) => withCourseOverride(state.assignments[index]));

  showMessage("Adding assignments to Google Tasks...", "");
  setLoading(true);

  try {
    // addAssignments preserves order, so results line up with selectedIndexes.
    const results = await AssignmentTasks.addAssignments(payload);

    const created = results.filter((result) => result.status === "created").length;
    const skipped = results.filter((result) => result.status === "skipped").length;

    results.forEach((result, position) => {
      const index = selectedIndexes[position];
      state.assignments[index] = {
        ...state.assignments[index],
        taskStatus: "already_added",
        taskId: result.taskId || state.assignments[index].taskId,
        taskLink: result.taskLink || state.assignments[index].taskLink,
      };
      state.selected.delete(index);
    });

    showMessage(
      `Google Tasks updated: ${created} created, ${skipped} already existed.`,
      "success",
    );
    renderAssignments();
    await refreshAuthStatus();
  } catch (error) {
    showMessage(error.message || "Could not add assignments.", "error");
  } finally {
    setLoading(false);
  }
}

function selectAllAssignments() {
  state.selected = new Set(selectableIndexes());
  renderAssignments();
}

function renderAssignments() {
  elements.assignmentList.textContent = "";

  const visible = state.assignments.filter((assignment) => !isHidden(assignment));
  const hiddenLate = state.assignments.length - visible.length;
  const count = visible.length;
  const alreadyAddedCount = visible.filter(isAlreadyAdded).length;
  const newCount = count - alreadyAddedCount;

  const hiddenNote = hiddenLate ? ` · ${hiddenLate} late hidden` : "";
  if (count) {
    elements.resultCount.textContent = `${newCount} new · ${alreadyAddedCount} added${hiddenNote}`;
  } else {
    elements.resultCount.textContent = state.assignments.length
      ? `All hidden${hiddenNote}`
      : "No assignments detected";
  }
  elements.selectAllButton.disabled = newCount === 0;
  elements.addButton.disabled = state.selected.size === 0;

  for (const [index, assignment] of state.assignments.entries()) {
    if (isHidden(assignment)) continue;

    const item = document.createElement("label");
    item.className = `assignment ${isAlreadyAdded(assignment) ? "isAdded" : ""}`.trim();

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(index) && !isAlreadyAdded(assignment);
    checkbox.disabled = isAlreadyAdded(assignment);
    checkbox.addEventListener("change", () => {
      if (isAlreadyAdded(assignment)) return;

      if (checkbox.checked) {
        state.selected.add(index);
      } else {
        state.selected.delete(index);
      }
      elements.addButton.disabled = state.selected.size === 0;
    });

    const content = document.createElement("div");

    const title = document.createElement("div");
    title.className = "assignmentTitle";
    title.textContent = assignment.title;

    const status = dueStatus(assignment);

    if (status?.overdue) {
      const lateBadge = document.createElement("span");
      lateBadge.className = "statusBadge late";
      lateBadge.textContent = "Late";
      title.append(" ", lateBadge);
    }

    if (isLowConfidence(assignment)) {
      const warnBadge = document.createElement("span");
      warnBadge.className = "statusBadge warn";
      warnBadge.textContent = "⚠ Check";
      warnBadge.title = `Low confidence (${Math.round((assignment.confidence ?? 0) * 100)}%) — double-check the date and title before adding.`;
      title.append(" ", warnBadge);
    }

    if (isAlreadyAdded(assignment)) {
      const badge = document.createElement("span");
      badge.className = "statusBadge";
      badge.textContent = "Added";
      title.append(" ", badge);
    }

    const meta = document.createElement("div");
    meta.className = "assignmentMeta";
    meta.textContent = [
      assignment.course,
      formatDateTime(assignment.dueAt),
      status?.label,
      assignment.source,
    ]
      .filter(Boolean)
      .join(" · ");

    content.append(title, meta);
    item.append(checkbox, content);
    elements.assignmentList.append(item);
  }
}

function setLoading(isLoading) {
  elements.scanButton.disabled = isLoading;
  elements.addButton.disabled = isLoading || state.selected.size === 0;
  elements.connectButton.disabled = isLoading;
}

function setUnsupportedState(isUnsupportedSite) {
  document.body.classList.toggle("unsupportedView", isUnsupportedSite);
  elements.emptyState.hidden = !isUnsupportedSite;
  elements.resultsSection.hidden = isUnsupportedSite;
  elements.actionsSection.hidden = isUnsupportedSite;
  elements.scanButton.hidden = isUnsupportedSite;

  if (isUnsupportedSite) {
    state.selected.clear();
    elements.addButton.disabled = true;
    elements.selectAllButton.disabled = true;
    elements.resultCount.textContent = "Unsupported site";
    elements.assignmentList.textContent = "";
  }
}

function showMessage(text, level) {
  elements.message.textContent = condenseMessage(text);
  elements.message.className = `message ${level || ""}`.trim();
}

function condenseMessage(text) {
  const value = String(text ?? "").trim();
  if (!value) return value;

  // Google's "API not enabled" error is a long paragraph; keep it user-facing.
  if (/tasks\.googleapis\.com|has not been used in project/i.test(value)) {
    return "Google Tasks access is not fully enabled for this version of DueList yet.";
  }

  // Leave short messages alone; trim long ones to their first sentence.
  if (value.length <= 140) return value;
  const firstSentence = value.split(/(?<=[.!?])\s+/)[0].trim();
  return firstSentence && firstSentence.length < value.length
    ? firstSentence
    : `${value.slice(0, 137).trimEnd()}…`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  // Drop the year to keep the meta line short; include it only when the
  // deadline isn't in the current year.
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

// Whether an assignment's deadline has already passed, plus a human-friendly
// relative label ("2 days ago", "in 3 days", "tomorrow").
function dueStatus(assignment) {
  const dueMs = Date.parse(assignment.dueAt);
  if (Number.isNaN(dueMs)) return null;

  const diffMs = dueMs - Date.now();
  return { overdue: diffMs < 0, label: relativeTime(diffMs) };
}

function relativeTime(diffMs) {
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(diffMs);

  if (abs >= day) return relative.format(Math.round(diffMs / day), "day");
  if (abs >= hour) return relative.format(Math.round(diffMs / hour), "hour");
  return relative.format(Math.round(diffMs / minute), "minute");
}

async function refreshAssignmentStatuses() {
  // Not signed in yet — not an error, just nothing to check against.
  if (!(await AssignmentTasks.isAuthenticated())) {
    state.assignments = state.assignments.map((assignment) => ({
      ...assignment,
      taskStatus: "unknown",
    }));
    return true;
  }

  try {
    // De-dup ignores the class prefix, so the detected assignments are enough.
    const results = await AssignmentTasks.checkAssignmentStatuses(state.assignments);

    state.assignments = state.assignments.map((assignment, index) => {
      const result = results[index];
      if (!result) return assignment;

      return {
        ...assignment,
        taskStatus: result.status,
        taskId: result.taskId,
        taskLink: result.taskLink,
      };
    });
    return true;
  } catch (error) {
    console.warn("Could not check existing Google Tasks", error);
    state.assignments = state.assignments.map((assignment) => ({
      ...assignment,
      taskStatus: "unknown",
    }));
    return false;
  }
}

async function scanTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/detectors.js"],
  });

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try {
        const detectors = window.AssignmentCalendarDetectors;
        if (!detectors) {
          return {
            ok: false,
            error: "Assignment detector did not load in this tab.",
          };
        }

        return {
          ok: true,
          assignments: detectors.detectAssignments({ document, location }),
          debug: detectors.debugPage({ document, location }),
        };
      } catch (error) {
        return {
          ok: false,
          error: error.message || "Could not scan this page.",
        };
      }
    },
  });

  return result?.result || { ok: false, error: "Scan did not return a result." };
}

function emptyScanMessage(debug) {
  if (!debug) return "No assignments found on this page.";

  if (!debug.matchedSite) {
    return `Unsupported site: ${debug.hostname}.`;
  }

  const linkCount = debug.assignmentLinks?.length || 0;
  if (linkCount) {
    return `No due dates found near ${linkCount} assignment link${linkCount === 1 ? "" : "s"}.`;
  }

  if (debug.lineCount) {
    return `No assignments found in ${debug.lineCount} visible text lines.`;
  }

  return "No readable page text found. Refresh the page and try again.";
}

function scanResultMessage(count, checkedTaskStatus) {
  const base = `Found ${count} assignment${count === 1 ? "" : "s"}.`;
  return checkedTaskStatus ? base : `${base} Couldn't check for duplicates.`;
}

function selectableIndexes() {
  return state.assignments
    .map((assignment, index) =>
      isAlreadyAdded(assignment) || isHidden(assignment) ? null : index,
    )
    .filter((index) => index !== null);
}

function isAlreadyAdded(assignment) {
  return assignment.taskStatus === "already_added";
}

function isLate(assignment) {
  const status = dueStatus(assignment);
  return Boolean(status && status.overdue);
}

// Assignments the detector isn't sure about — warn the user to double-check.
const LOW_CONFIDENCE_THRESHOLD = 0.6;

function isLowConfidence(assignment) {
  return typeof assignment.confidence === "number" && assignment.confidence < LOW_CONFIDENCE_THRESHOLD;
}

function isHidden(assignment) {
  return state.hideLate && isLate(assignment);
}
