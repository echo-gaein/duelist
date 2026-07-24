const assert = require("node:assert");
const {
  fingerprintAssignment,
  taskDueDate,
  buildGoogleTask,
  isAllowedOrigin,
  isLocalHost,
  rememberOAuthState,
  consumeOAuthState,
} = require("../server");

const baseAssignment = {
  source: "Gradescope",
  course: "CS 61A",
  title: "Lab 3",
  dueAt: "2027-07-03T06:59:00.000Z",
  dueDate: "2027-07-02",
  url: "https://www.gradescope.com/courses/1/assignments/3",
};

// Fingerprint is stable, 32 hex chars, and changes when a keyed field changes.
const fp = fingerprintAssignment(baseAssignment);
assert.match(fp, /^[0-9a-f]{32}$/, "fingerprint should be 32 hex chars");
assert.strictEqual(fp, fingerprintAssignment({ ...baseAssignment }), "fingerprint should be stable");
assert.notStrictEqual(
  fp,
  fingerprintAssignment({ ...baseAssignment, title: "Lab 4" }),
  "fingerprint should change with the title",
);
// dueDate is not part of the fingerprint, so dedup survives adding it.
assert.strictEqual(
  fp,
  fingerprintAssignment({ ...baseAssignment, dueDate: undefined }),
  "dueDate must not affect the fingerprint",
);

// taskDueDate prefers the browser-local dueDate over the UTC dueAt instant.
assert.strictEqual(
  taskDueDate(baseAssignment),
  "2027-07-02T00:00:00.000Z",
  "should use the local dueDate, not the UTC day",
);
assert.match(
  taskDueDate({ dueAt: baseAssignment.dueAt }),
  /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/,
  "should fall back to a valid date-only value when dueDate is absent",
);

// buildGoogleTask prefixes the course and embeds the fingerprint in the notes.
const task = buildGoogleTask(baseAssignment, fp);
assert.strictEqual(task.title, "CS 61A: Lab 3");
assert.ok(task.notes.includes(fp), "notes should embed the fingerprint");
assert.strictEqual(task.due, "2027-07-02T00:00:00.000Z");

// Origin allowlist: extension yes, websites no, empty (top-level nav) yes.
assert.strictEqual(isAllowedOrigin("chrome-extension://abcdef"), true);
assert.strictEqual(isAllowedOrigin("https://evil.example.com"), false);
assert.strictEqual(isAllowedOrigin("http://localhost:8787"), false);
assert.strictEqual(isAllowedOrigin(""), true);

// Host allowlist: loopback only, blocks rebinding hostnames.
assert.strictEqual(isLocalHost({ headers: { host: "127.0.0.1:8787" } }), true);
assert.strictEqual(isLocalHost({ headers: { host: "localhost:8787" } }), true);
assert.strictEqual(isLocalHost({ headers: { host: "evil.example.com" } }), false);
assert.strictEqual(isLocalHost({ headers: {} }), false);

// OAuth state is single-use and rejects unknown values.
const state = "test-state-123";
rememberOAuthState(state);
assert.strictEqual(consumeOAuthState(state), true, "issued state should validate once");
assert.strictEqual(consumeOAuthState(state), false, "state should not be reusable");
assert.strictEqual(consumeOAuthState("never-issued"), false, "unknown state should be rejected");

console.log("server.test.js passed");
