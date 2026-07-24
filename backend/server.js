const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL, URLSearchParams } = require("node:url");

loadEnv();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN_PATH = path.join(__dirname, "tokens.json");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;
const TASKLIST_ID = process.env.TASKLIST_ID || "@default";
const SCOPES = ["https://www.googleapis.com/auth/tasks"];
// Kept verbatim for backward compatibility: it is embedded in the notes of
// every task this tool has already created, and is how duplicates are matched.
const FINGERPRINT_PREFIX = "Assignment Calendar Sync fingerprint:";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const pendingOAuthStates = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const origin = req.headers.origin || "";
    setCors(res, origin);

    // Reject anything whose Host header is not localhost. The server only binds
    // to a loopback address, but this also blocks DNS-rebinding attacks where a
    // malicious page uses a hostname that resolves to 127.0.0.1.
    if (!isLocalHost(req)) {
      sendJson(res, 403, { error: "Forbidden host." });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Browser (CORS) requests must come from the extension itself, not from an
    // arbitrary website whose JavaScript happens to reach localhost. Requests
    // with no Origin (top-level navigations like the OAuth flow) are allowed.
    if (origin && !isAllowedOrigin(origin)) {
      sendJson(res, 403, { error: "Forbidden origin." });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        hasGoogleConfig: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
        authenticated: Boolean(readTokens() && hasRequiredScopes(readTokens())),
        taskListId: TASKLIST_ID,
        missingScopes: missingRequiredScopes(readTokens()),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth/google") {
      redirectToGoogle(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/oauth2callback") {
      await handleOAuthCallback(url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/events") {
      const body = await readJsonBody(req);
      const assignments = Array.isArray(body.assignments)
        ? body.assignments
        : body.assignment
          ? [body.assignment]
          : [];

      if (!assignments.length) {
        sendJson(res, 400, { error: "Expected assignment or assignments." });
        return;
      }

      const results = [];
      for (const assignment of assignments) {
        results.push(await upsertAssignmentTask(assignment));
      }

      sendJson(res, 200, { results });
      return;
    }

    if (req.method === "POST" && url.pathname === "/events/status") {
      const body = await readJsonBody(req);
      const assignments = Array.isArray(body.assignments) ? body.assignments : [];

      if (!assignments.length) {
        sendJson(res, 400, { error: "Expected assignments." });
        return;
      }

      const results = await checkAssignmentStatuses(assignments);
      sendJson(res, 200, { results });
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Unexpected server error." });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Assignment Calendar Sync backend running on http://${HOST}:${PORT}`);
  });
}

module.exports = {
  fingerprintAssignment,
  taskDueDate,
  buildGoogleTask,
  isAllowedOrigin,
  isLocalHost,
  rememberOAuthState,
  consumeOAuthState,
};

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function setCors(res, origin) {
  // Only reflect the origin back when it is the extension. Websites that try a
  // cross-origin request will not receive an Allow-Origin header, so the
  // browser blocks them before the request is even acted on.
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function isAllowedOrigin(origin) {
  return !origin || origin.startsWith("chrome-extension://");
}

function isLocalHost(req) {
  const hostname = String(req.headers.host || "").replace(/:\d+$/, "");
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
}

function redirectToGoogle(res) {
  assertGoogleConfig();

  const state = crypto.randomBytes(16).toString("hex");
  rememberOAuthState(state);

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });

  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
  });
  res.end();
}

async function handleOAuthCallback(url, res) {
  assertGoogleConfig();

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h1>Google authorization failed</h1><p>${escapeHtml(error)}</p>`);
    return;
  }

  // Reject callbacks whose state we did not issue (CSRF protection).
  if (!consumeOAuthState(state)) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(
      "<h1>Invalid or expired OAuth state</h1><p>Restart the Google connection from the extension.</p>",
    );
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>Missing OAuth code</h1>");
    return;
  }

  const tokenResponse = await googleTokenRequest({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code",
  });

  saveTokens(withExpiry({ scope: SCOPES.join(" "), ...tokenResponse }));

  // The extension's background worker closes this tab on success, returning the
  // user to the page they came from. The body is a minimal fallback for when
  // the flow is completed without the extension loaded.
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    "<!doctype html><meta charset=\"utf-8\"><title>Connected</title>" +
      "<body style=\"font:14px system-ui;margin:24px\">Google connected — you can close this tab.</body>",
  );
}

async function upsertAssignmentTask(assignment) {
  validateAssignment(assignment);

  const tokens = await getFreshTokens();
  const fingerprint = fingerprintAssignment(assignment);
  const existing = await findExistingTask(tokens.access_token, fingerprint);

  if (existing) {
    return {
      status: "skipped",
      reason: "already_exists",
      fingerprint,
      taskId: existing.id,
      taskLink: existing.selfLink,
      assignment,
    };
  }

  const created = await googleJsonRequest({
    method: "POST",
    url: tasksUrl("/tasks"),
    accessToken: tokens.access_token,
    body: buildGoogleTask(assignment, fingerprint),
  });

  return {
    status: "created",
    fingerprint,
    taskId: created.id,
    taskLink: created.selfLink,
    assignment,
  };
}

async function checkAssignmentStatuses(assignments) {
  const tokens = await getFreshTokens();
  const taskIndex = await listAssignmentTasks(tokens.access_token);
  const results = [];

  for (const assignment of assignments) {
    validateAssignment(assignment);

    const fingerprint = fingerprintAssignment(assignment);
    const existing = taskIndex.get(fingerprint);

    results.push({
      status: existing ? "already_added" : "not_added",
      fingerprint,
      taskId: existing?.id || null,
      taskLink: existing?.selfLink || null,
      assignment,
    });
  }

  return results;
}

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

function buildGoogleTask(assignment, fingerprint) {
  const title = assignment.course
    ? `${assignment.course}: ${assignment.title}`
    : assignment.title;

  const notesParts = [
    assignment.source ? `Source: ${assignment.source}` : null,
    assignment.url ? `URL: ${assignment.url}` : null,
    assignment.rawDueText ? `Detected due text: ${assignment.rawDueText}` : null,
    `Deadline: ${formatDeadlineForNotes(assignment.dueAt)}`,
    `${FINGERPRINT_PREFIX} ${fingerprint}`,
  ].filter(Boolean);

  return {
    title,
    notes: notesParts.join("\n"),
    due: taskDueDate(assignment),
  };
}

async function findExistingTask(accessToken, fingerprint) {
  const taskIndex = await listAssignmentTasks(accessToken);
  return taskIndex.get(fingerprint) || null;
}

async function listAssignmentTasks(accessToken) {
  const taskIndex = new Map();
  let pageToken = "";

  do {
    const params = new URLSearchParams({
      maxResults: "100",
      showCompleted: "true",
      showDeleted: "false",
      showHidden: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await googleJsonRequest({
      method: "GET",
      url: `${tasksUrl("/tasks")}?${params}`,
      accessToken,
    });

    for (const task of response.items || []) {
      const fingerprint = extractTaskFingerprint(task);
      if (fingerprint && !taskIndex.has(fingerprint)) {
        taskIndex.set(fingerprint, task);
      }
    }

    pageToken = response.nextPageToken || "";
  } while (pageToken);

  return taskIndex;
}

function extractTaskFingerprint(task) {
  const notes = task?.notes || "";
  const line = notes
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(FINGERPRINT_PREFIX));

  return line ? line.slice(FINGERPRINT_PREFIX.length).trim() : "";
}

function taskDueDate(assignment) {
  // Google Tasks only stores a date (no time). Prefer the calendar date the
  // detector computed in the browser's timezone (assignment.dueDate), so the
  // day cannot drift when the backend runs in a different timezone than the
  // browser. Fall back to deriving it from the dueAt instant in local time.
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

function tasksUrl(pathname) {
  return `https://tasks.googleapis.com/tasks/v1/lists/${taskListIdForPath()}${pathname}`;
}

function taskListIdForPath() {
  return TASKLIST_ID === "@default" ? "@default" : encodeURIComponent(TASKLIST_ID);
}

async function getFreshTokens() {
  assertGoogleConfig();

  const tokens = readTokens();
  if (!tokens) {
    throw new Error("Google Tasks is not authenticated. Visit /auth/google first.");
  }

  if (!hasRequiredScopes(tokens)) {
    throw new Error("Google Tasks permission is missing. Reconnect Google.");
  }

  if (tokens.expires_at && tokens.expires_at > Date.now() + 60_000) {
    return tokens;
  }

  if (!tokens.refresh_token) {
    throw new Error("Missing refresh token. Reconnect Google.");
  }

  const refreshed = await googleTokenRequest({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token",
  });

  const nextTokens = withExpiry({
    ...tokens,
    ...refreshed,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
  });

  saveTokens(nextTokens);
  return nextTokens;
}

function hasRequiredScopes(tokens) {
  return missingRequiredScopes(tokens).length === 0;
}

function missingRequiredScopes(tokens) {
  if (!tokens?.scope) return SCOPES;
  const tokenScopes = new Set(String(tokens.scope).split(/\s+/).filter(Boolean));
  return SCOPES.filter((scope) => !tokenScopes.has(scope));
}

function googleTokenRequest(payload) {
  return requestJson({
    method: "POST",
    url: "https://oauth2.googleapis.com/token",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(payload).toString(),
  });
}

function googleJsonRequest({ method, url, accessToken, body }) {
  return requestJson({
    method,
    url,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function requestJson({ method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request(
      parsed,
      {
        method,
        headers: {
          ...headers,
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          let parsedBody = {};
          if (data) {
            try {
              parsedBody = JSON.parse(data);
            } catch (error) {
              reject(new Error(`Expected JSON but received: ${data.slice(0, 200)}`));
              return;
            }
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                parsedBody.error_description ||
                  parsedBody.error?.message ||
                  `Google request failed with status ${response.statusCode}`,
              ),
            );
            return;
          }

          resolve(parsedBody);
        });
      },
    );

    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function readTokens() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, `${JSON.stringify(tokens, null, 2)}\n`);
}

function withExpiry(tokens) {
  return {
    ...tokens,
    expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000,
  };
}

function fingerprintAssignment(assignment) {
  const stable = [
    assignment.source || "",
    assignment.course || "",
    assignment.title || "",
    new Date(assignment.dueAt).toISOString(),
    assignment.url || "",
  ].join("|");

  return crypto.createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

function assertGoogleConfig() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in backend/.env.");
  }
}

function rememberOAuthState(state) {
  purgeExpiredOAuthStates();
  pendingOAuthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
}

function consumeOAuthState(state) {
  if (!state) return false;
  purgeExpiredOAuthStates();
  const expiresAt = pendingOAuthStates.get(state);
  pendingOAuthStates.delete(state);
  return Boolean(expiresAt) && expiresAt > Date.now();
}

function purgeExpiredOAuthStates() {
  const now = Date.now();
  for (const [value, expiresAt] of pendingOAuthStates) {
    if (expiresAt <= now) pendingOAuthStates.delete(value);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
