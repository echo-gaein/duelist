const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");

// Load googleTasks.js in a sandbox with the browser globals it relies on. Its
// auth/API functions reference chrome/fetch only inside function bodies, so the
// module loads fine here and we exercise the pure helpers.
const context = { Intl, Date, console };
vm.createContext(context);
vm.runInContext(fs.readFileSync("frontend/src/googleTasks.js", "utf8"), context);
const Tasks = context.AssignmentTasks;

const assignment = {
  source: "Pensive",
  course: "Data 8",
  title: "Homework 3",
  dueAt: "2026-07-25T06:59:00.000Z",
  dueDate: "2026-07-24",
  url: "https://www.pensive.com/student/classes/data8_su26/my-assignments",
  rawDueText: "Jul 24 11:59 PM",
};

// Title prefixes the course.
assert.strictEqual(Tasks.taskTitle(assignment), "Data 8: Homework 3");
assert.strictEqual(Tasks.taskTitle({ ...assignment, course: "" }), "Homework 3");

// taskDueDate prefers the browser-local dueDate over the UTC instant.
assert.strictEqual(Tasks.taskDueDate(assignment), "2026-07-24T00:00:00.000Z");
assert.match(
  Tasks.taskDueDate({ dueAt: assignment.dueAt }),
  /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/,
);

// De-dup matches on the assignment name, with OR without a class prefix, so the
// "already added" state survives typing a class name.
assert.ok(Tasks.titleMatches("Homework 3", "Homework 3"), "exact title matches");
assert.ok(Tasks.titleMatches("CS 61A: Homework 3", "Homework 3"), "prefixed title matches");
assert.ok(Tasks.titleMatches("Data 8: Homework 3", "Homework 3"), "any prefix matches");
assert.ok(Tasks.titleMatches("  cs 61a:   homework 3 ", "Homework 3"), "case/space-insensitive");
assert.ok(!Tasks.titleMatches("CS 61A: Homework 4", "Homework 3"), "different assignment does not match");
assert.ok(!Tasks.titleMatches("My Homework 3", "Homework 3"), "substring without ': ' does not match");
assert.ok(!Tasks.titleMatches("Homework 3", ""), "empty assignment title never matches");

// Notes keep only URL + Deadline — no Source, detected text, or fingerprint.
const task = Tasks.buildGoogleTask(assignment);
assert.strictEqual(task.title, "Data 8: Homework 3");
assert.strictEqual(task.due, "2026-07-24T00:00:00.000Z");
assert.ok(task.notes.includes("URL: https://www.pensive.com"), "notes should keep the URL");
assert.ok(/Deadline:/.test(task.notes), "notes should keep the Deadline");
assert.ok(!/Source:/i.test(task.notes), "notes should not include Source");
assert.ok(!/Detected due text/i.test(task.notes), "notes should not include detected due text");
assert.ok(!/fingerprint/i.test(task.notes), "notes should not include a fingerprint");
assert.strictEqual(task.notes.split("\n").length, 2, "notes should be exactly two lines");

console.log("googleTasks.test.js passed");
