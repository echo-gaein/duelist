const fs = require("node:fs");
const vm = require("node:vm");

function makeElement(tagName, attrs = {}, children = [], text = "") {
  return {
    tagName: tagName.toUpperCase(),
    attrs,
    children,
    parent: null,
    textContent: text,
    get innerText() {
      return [this.textContent, ...this.children.map((child) => child.innerText)]
        .filter(Boolean)
        .join("\n");
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    querySelectorAll(selector) {
      const selectors = selector.split(",").map((item) => item.trim());
      const results = [];
      walk(this, (node) => {
        if (node !== this && selectors.some((part) => matches(node, part))) {
          results.push(node);
        }
      });
      return results;
    },
    closest(selector) {
      let node = this.parent;
      while (node) {
        if (selector.split(",").some((part) => matches(node, part.trim()))) return node;
        node = node.parent;
      }
      return null;
    },
    getAttribute(name) {
      return this.attrs[name] || null;
    },
  };
}

function walk(node, callback) {
  callback(node);
  for (const child of node.children) walk(child, callback);
}

// Minimal CSS matcher: an optional tag name followed by any number of
// `.class`, `[attr]`, `[attr=v]`, or `[attr*=v]` clauses (quotes optional).
function matches(node, selector) {
  selector = selector.trim();
  if (!selector) return false;
  if (selector === "*") return true;

  let rest = selector;
  const tag = rest.match(/^[a-zA-Z][\w-]*/);
  if (tag) {
    if (node.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
    rest = rest.slice(tag[0].length);
  }

  let matchedSomething = Boolean(tag);
  const clause = /\.([\w-]+)|\[([^\]]+)\]/g;
  let part;
  while ((part = clause.exec(rest)) !== null) {
    matchedSomething = true;
    if (part[1] !== undefined) {
      const classes = String(node.attrs.class || "").split(/\s+/);
      if (!classes.includes(part[1])) return false;
      continue;
    }

    const attr = part[2].match(/^([\w-]+)\s*(?:([*^$]?)=\s*(.+))?$/);
    if (!attr) return false;
    const value = node.attrs[attr[1]];
    if (attr[3] === undefined) {
      if (value === undefined || value === null) return false;
      continue;
    }
    const expected = attr[3].replace(/^['"]|['"]$/g, "");
    if (value === undefined || value === null) return false;
    if (attr[2] === "*" && !String(value).includes(expected)) return false;
    if (attr[2] === "^" && !String(value).startsWith(expected)) return false;
    if (attr[2] === "$" && !String(value).endsWith(expected)) return false;
    if (attr[2] === "" && String(value) !== expected) return false;
  }

  return matchedSomething;
}

function el(tagName, attrsOrChildren, childrenOrText, maybeText) {
  const hasAttrs = !Array.isArray(attrsOrChildren) && typeof attrsOrChildren === "object";
  const attrs = hasAttrs ? attrsOrChildren : {};
  const children = hasAttrs ? childrenOrText || [] : attrsOrChildren || [];
  const text = hasAttrs ? maybeText || "" : childrenOrText || "";
  const node = makeElement(tagName, attrs, children, text);
  for (const child of children) child.parent = node;
  return node;
}

const row = el("tr", [
  el("td", [el("a", { href: "/courses/1324284/assignments/1" }, [], "Lab 3")]),
  el("td", [], "No Submission"),
  el("td", [], "Jul 01 at 8:00AM"),
  el("td", [], "1 day, 10 hours left\nJul 02 at 11:59PM\nLate Due Date: Aug 10 at 11:59PM"),
]);
// Already submitted — should be filtered out of the scan.
const submittedRow = el("tr", [
  el("td", [el("a", { href: "/courses/1324284/assignments/2" }, [], "Lab 2")]),
  el("td", [], "Submitted"),
  el("td", [], "Jun 20 at 8:00AM"),
  el("td", [], "Jun 25 at 11:59PM\nLate Due Date: Aug 10 at 11:59PM"),
]);
// Already graded (has a score) — should be filtered out of the scan.
const gradedRow = el("tr", [
  el("td", [el("a", { href: "/courses/1324284/assignments/3" }, [], "Lab 1")]),
  el("td", [], "8.0 / 10.0"),
  el("td", [], "Jun 10 at 8:00AM"),
  el("td", [], "Jun 15 at 11:59PM\nLate Due Date: Aug 10 at 11:59PM"),
]);
// Unsubmitted, but the title itself contains a slash ("Reading 1/2"). Must NOT
// be mistaken for a score and dropped.
const slashTitleRow = el("tr", [
  el("td", [el("a", { href: "/courses/1324284/assignments/4" }, [], "Reading 1/2")]),
  el("td", [], "No Submission"),
  el("td", [], "Jul 03 at 8:00AM"),
  el("td", [], "3 days left\nJul 09 at 11:59PM\nLate Due Date: Aug 10 at 11:59PM"),
]);
// Real Gradescope shape: name in a .table--primaryLink <th>, a non-keyword
// title ("Ants"), and a link that doesn't match /assignments/<id>. Must still
// be detected via the primary-link cell.
const antsRow = el("tr", { role: "row", class: "even" }, [
  el("th", { class: "table--primaryLink", role: "rowheader" }, [
    el("a", { href: "#" }, [], "Ants"),
  ]),
  el("td", { class: "submissionStatus submissionStatus-warning" }, [], "No Submission"),
  el(
    "td",
    { class: "sorting_1 sorting_2" },
    [],
    "4 days, 14 hours left\nJul 18 at 4:00PM\nJul 28 at 11:59PM\nLate Due Date: Aug 10 at 11:59PM",
  ),
]);
const h1 = el("h1", [], "CS 61A Summer 2027");
const document = {
  title: "CS 61A Summer 2027 | Gradescope",
  querySelector(selector) {
    if (selector === "h1") return h1;
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes("tr")) return [row, submittedRow, gradedRow, slashTitleRow, antsRow];
    return [];
  },
};

const context = { window: {}, console, URL };
vm.createContext(context);
vm.runInContext(fs.readFileSync("frontend/src/detectors.js", "utf8"), context);

const assignments = context.window.AssignmentCalendarDetectors.detectAssignments({
  document,
  location: { href: "https://www.gradescope.com/courses/1324284", hostname: "gradescope.com" },
});

const detectedTitles = assignments.map((a) => a.title);

if (assignments.length !== 3) {
  throw new Error(
    `Expected 3 unsubmitted assignments, received ${assignments.length}: ${detectedTitles.join(", ")}`,
  );
}

if (assignments[0].title !== "Lab 3") {
  throw new Error(`Expected Lab 3 first (earliest due), received ${assignments[0].title}`);
}

if (!detectedTitles.includes("Reading 1/2")) {
  throw new Error("Unsubmitted 'Reading 1/2' (slash in title) should not be filtered out");
}
if (!detectedTitles.includes("Ants")) {
  throw new Error("Unsubmitted 'Ants' (non-keyword name in a th) should be detected");
}
if (detectedTitles.includes("Lab 2")) {
  throw new Error("Submitted assignment (Lab 2) should have been filtered out");
}
if (detectedTitles.includes("Lab 1")) {
  throw new Error("Graded assignment (Lab 1) should have been filtered out");
}

if (!assignments[0].rawDueText.includes("Jul 02")) {
  throw new Error(`Expected primary due date, received ${assignments[0].rawDueText}`);
}

if (!assignments[0].dueAt.includes("2027")) {
  throw new Error(`Expected course year 2027, received ${assignments[0].dueAt}`);
}

console.log(assignments[0]);

const fakeGradescopeAssignments = context.window.AssignmentCalendarDetectors.detectAssignments({
  document,
  location: {
    href: "https://not-gradescope-example.com/courses/1324284",
    hostname: "not-gradescope-example.com",
  },
});

if (fakeGradescopeAssignments.length !== 0) {
  throw new Error(
    `Expected fake Gradescope hostname to be unsupported, received ${fakeGradescopeAssignments.length}`,
  );
}

const pensiveRow = el("tr", [
  el("td", [el("a", { href: "/courses/cs61a/assignments/project-1" }, [], "Project 1")]),
  el("td", [], "Released Jun 25 at 8:00AM"),
  el("td", [], "6 days, 9 hours left\nDue Date: Jul 07 at 11:59PM\nLate Due Date: Aug 10 at 11:59PM"),
]);
const pensiveTitle = el("h1", [], "CS 61A Summer 2027");
const pensiveDocument = {
  title: "CS 61A Summer 2027 | Pensive",
  querySelector(selector) {
    if (selector === "h1") return pensiveTitle;
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes("tr")) return [pensiveRow];
    return [];
  },
};

const pensiveAssignments = context.window.AssignmentCalendarDetectors.detectAssignments({
  document: pensiveDocument,
  location: { href: "https://pensive.com/courses/cs61a", hostname: "pensive.com" },
});

if (pensiveAssignments.length !== 1) {
  throw new Error(`Expected 1 Pensive assignment, received ${pensiveAssignments.length}`);
}

if (!pensiveAssignments[0].rawDueText.includes("Jul 07")) {
  throw new Error(`Expected Pensive primary due date, received ${pensiveAssignments[0].rawDueText}`);
}

if (pensiveAssignments[0].rawDueText.includes("Aug 10")) {
  throw new Error(`Expected Pensive late due date to be ignored, received ${pensiveAssignments[0].rawDueText}`);
}

if (pensiveAssignments[0].source !== "Pensive") {
  throw new Error(`Expected Pensive source, received ${pensiveAssignments[0].source}`);
}

console.log(pensiveAssignments[0]);

// Every detected assignment should carry a browser-local YYYY-MM-DD dueDate so
// Google Tasks can store the intended calendar day regardless of timezone.
for (const assignment of [assignments[0], pensiveAssignments[0]]) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(assignment.dueDate || "")) {
    throw new Error(`Expected a YYYY-MM-DD dueDate, received ${assignment.dueDate}`);
  }
  if (!assignment.dueAt.startsWith(assignment.dueDate.slice(0, 4))) {
    throw new Error(`dueDate year should match dueAt, received ${assignment.dueDate} / ${assignment.dueAt}`);
  }
}

// Generic detector path: a Pensive page whose assignment title is only
// reachable via a [class*='name'] selector (exercises the class matcher).
const genericItem = el("li", { class: "assignment-row" }, [
  el("div", { class: "assignment-name" }, [], "Homework 5"),
  el("div", [], "Due Date: Aug 15 at 11:59PM\nLate Due Date: Aug 20 at 11:59PM"),
]);
const genericHeading = el("h1", [], "CS 200");
const genericDocument = {
  title: "CS 200 Fall 2027 | Pensive",
  querySelector(selector) {
    if (selector === "h1") return genericHeading;
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes("li")) return [genericItem];
    return [];
  },
};

const genericAssignments = context.window.AssignmentCalendarDetectors.detectAssignments({
  document: genericDocument,
  location: { href: "https://pensive.com/courses/cs200", hostname: "pensive.com" },
});

if (genericAssignments.length !== 1) {
  throw new Error(`Expected 1 generic assignment, received ${genericAssignments.length}`);
}

if (genericAssignments[0].title !== "Homework 5") {
  throw new Error(`Expected Homework 5 via class selector, received ${genericAssignments[0].title}`);
}

if (genericAssignments[0].rawDueText.includes("Aug 20")) {
  throw new Error(`Expected late due date to be ignored, received ${genericAssignments[0].rawDueText}`);
}

// dueAt is a UTC instant that can land on the next calendar day; the local
// dueDate is what the extension sends to Google Tasks, so assert on that.
if (genericAssignments[0].dueDate !== "2027-08-15") {
  throw new Error(`Expected Aug 15 2027 local dueDate, received ${genericAssignments[0].dueDate}`);
}

console.log(genericAssignments[0]);

// Pensive: an explicitly submitted item must be skipped by the generic filter.
const pensiveSubmittedRow = el("tr", [
  el("td", [el("a", { href: "/courses/cs61a/assignments/project-0" }, [], "Project 0")]),
  el("td", [], "Submitted"),
  el("td", [], "Due Date: Jul 01 at 11:59PM\nLate Due Date: Aug 10 at 11:59PM"),
]);
const pensiveMixedDocument = {
  title: "CS 61A Summer 2027 | Pensive",
  querySelector(selector) {
    if (selector === "h1") return el("h1", [], "CS 61A Summer 2027");
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes("tr")) return [pensiveRow, pensiveSubmittedRow];
    return [];
  },
};
const pensiveMixed = context.window.AssignmentCalendarDetectors.detectAssignments({
  document: pensiveMixedDocument,
  location: { href: "https://pensive.com/courses/cs61a", hostname: "pensive.com" },
});
if (pensiveMixed.some((a) => a.title === "Project 0")) {
  throw new Error("Submitted Pensive item (Project 0) should have been filtered out");
}
if (!pensiveMixed.some((a) => a.title === "Project 1")) {
  throw new Error("Unsubmitted Pensive item (Project 1) should still be detected");
}

// Course name: a generic "My Assignments" heading should be rejected in favor
// of the class slug from the URL (/classes/data8_su26/ -> "Data8 Su26").
const slugItem = el("li", { class: "assignment-row" }, [
  el("div", { class: "assignment-name" }, [], "Homework 3"),
  el("div", [], "Due Date: Jul 24 at 11:59PM"),
]);
const slugDocument = {
  title: "My Assignments | Pensive",
  querySelector(selector) {
    if (selector === "h1") return el("h1", [], "My Assignments");
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes("li")) return [slugItem];
    return [];
  },
};
const slugAssignments = context.window.AssignmentCalendarDetectors.detectAssignments({
  document: slugDocument,
  location: {
    href: "https://www.pensive.com/student/classes/data8_su26/my-assignments",
    hostname: "pensive.com",
  },
});
if (!slugAssignments.length) {
  throw new Error("Expected the Pensive slug page to yield an assignment");
}
if (slugAssignments[0].course !== "Data 8") {
  throw new Error(`Expected course 'Data 8' from the URL (term dropped), received '${slugAssignments[0].course}'`);
}

// --- Canvas / bCourses ---
function canvasRow(id, title, dueText, extra = []) {
  return el("li", { class: "ig-row assignment" }, [
    el("a", { class: "ig-title", href: `/courses/123/assignments/${id}`, title }, [], title),
    el("div", { class: "ig-details" }, [
      el("span", { class: "assignment-date-due" }, [], dueText),
      ...extra,
    ]),
  ]);
}
const canvasDocument = {
  title: "CS 61A Fall 2027",
  querySelector(selector) {
    if (selector === "h1") return el("h1", [], "CS 61A");
    return null;
  },
  querySelectorAll(selector) {
    if (selector === "li.ig-row") {
      return [
        canvasRow(1, "Project 1", "Due: Sep 5 by 11:59pm"),
        canvasRow(2, "Reading Quiz 3", "Due: Sep 12 at 11:59pm"),
        // Explicitly submitted — must be skipped.
        canvasRow(3, "Lab 0", "Due: Aug 30 at 11:59pm", [
          el("span", { class: "submission-status" }, [], "Submitted"),
        ]),
      ];
    }
    return [];
  },
};
const canvasAssignments = context.window.AssignmentCalendarDetectors.detectAssignments({
  document: canvasDocument,
  location: {
    href: "https://bcourses.berkeley.edu/courses/123/assignments",
    hostname: "bcourses.berkeley.edu",
  },
});
const canvasTitles = canvasAssignments.map((a) => a.title);
if (canvasAssignments.length !== 2) {
  throw new Error(`Expected 2 Canvas assignments, received ${canvasAssignments.length}: ${canvasTitles.join(", ")}`);
}
if (!canvasTitles.includes("Project 1") || !canvasTitles.includes("Reading Quiz 3")) {
  throw new Error(`Expected Project 1 and Reading Quiz 3, received ${canvasTitles.join(", ")}`);
}
if (canvasTitles.includes("Lab 0")) {
  throw new Error("Submitted Canvas assignment (Lab 0) should have been skipped");
}
if (canvasAssignments[0].source !== "bCourses") {
  throw new Error(`Expected bCourses source, received ${canvasAssignments[0].source}`);
}
if (canvasAssignments[0].dueDate !== "2027-09-05") {
  throw new Error(`Expected 2027-09-05 dueDate, received ${canvasAssignments[0].dueDate}`);
}
console.log(canvasAssignments);

console.log("detectors.test.js passed");
