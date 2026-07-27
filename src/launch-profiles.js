// Launch profiles — per-tab AI CLI selection.
//
// A profile names a command to auto-run in a new tab plus the environment it
// runs under, so one tab can hold Claude Code while another holds an
// OpenAI-compatible CLI pointed at a gateway (OpenRouter, a local model, ...).
//
// Env values hold *references* (`$OPENROUTER_API_KEY`), not secrets. They are
// expanded from the Wotch process environment at spawn time, which keeps API
// keys out of ~/.wotch/settings.json — see INV-SEC-020 in docs/INVARIANTS.md.

const MAX_PROFILES = 20;
const MAX_NAME_LEN = 60;
const MAX_COMMAND_LEN = 500;
const MAX_ENV_ENTRIES = 40;
const MAX_ENV_VALUE_LEN = 2000;

// POSIX-ish env var name. Also what we accept on the left of `=` in the editor.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// `$$` (escaped literal), `${NAME}`, or `$NAME`.
const ENV_REF_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

// A value made up only of references and whitespace carries no secret material.
const PURE_REF_RE = /^(?:\s|\$\$|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)+$/;

// Key names that conventionally carry secrets, used for API redaction only.
const SECRETISH_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/**
 * Expand `$VAR` / `${VAR}` references against `sourceEnv`. `$$` yields a
 * literal `$`. Unset variables expand to the empty string, matching shell
 * behaviour.
 *
 * Single-pass by construction: `String.replace` does not rescan what it
 * substitutes, so a variable whose *value* contains `$FOO` is never expanded
 * a second time.
 */
function expandEnvRefs(value, sourceEnv) {
  if (typeof value !== "string") return "";
  const env = sourceEnv || {};
  return value.replace(ENV_REF_RE, (match, braced, bare) => {
    if (match === "$$") return "$";
    const name = braced || bare;
    const resolved = env[name];
    return typeof resolved === "string" ? resolved : "";
  });
}

/** True when a value is only references/whitespace — safe to show over the API. */
function isPureEnvReference(value) {
  return typeof value === "string" && value.length > 0 && PURE_REF_RE.test(value);
}

/**
 * True when a value contains at least one real `$NAME` / `${NAME}` reference.
 * `$$` is an escape producing a literal `$`, so it does not count — dropping
 * escapes first keeps `$$FOO` (literal) from passing as a reference.
 */
function containsEnvReference(value) {
  if (typeof value !== "string") return false;
  const withoutEscapes = value.replace(/\$\$/g, "");
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(withoutEscapes);
}

/** True for key names that conventionally carry a credential. */
function isSecretishKey(key) {
  return typeof key === "string" && SECRETISH_KEY_RE.test(key);
}

/**
 * Enforce INV-SEC-020 at the write boundary: a credential-shaped key may not
 * carry literal secret material, because profile env is persisted to
 * ~/.wotch/settings.json in plain text.
 *
 * Permitted under such a key:
 *   - the empty string (clearing a variable, e.g. ANTHROPIC_API_KEY=)
 *   - anything containing a `$NAME` reference, including decorated forms
 *     such as `Bearer $TOKEN` — the secret itself still never touches disk
 *
 * This is a guard against accident, not against a user determined to defeat
 * it on their own machine. Returns an error string, or null when the env is
 * acceptable. Callers apply it on save only; reads stay permissive so an
 * existing settings file is never silently rewritten.
 */
function validateProfileEnv(env) {
  if (!env || typeof env !== "object") return null;
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value !== "string") continue;
    if (!isSecretishKey(key)) continue;
    if (value === "" || containsEnvReference(value)) continue;
    return `${key} looks like a literal secret. Reference it as $NAME instead — `
      + "profile env is stored in plain text (INV-SEC-020).";
  }
  return null;
}

/** Parse `KEY=VALUE` lines from the settings editor. Blank lines and `#` comments are skipped. */
function parseEnvLines(text) {
  const env = {};
  if (typeof text !== "string") return env;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!ENV_NAME_RE.test(key)) continue;
    // Preserve internal spacing; only strip whitespace around the assignment.
    let value = line.slice(eq + 1).trim();
    if (value.length > MAX_ENV_VALUE_LEN) value = value.slice(0, MAX_ENV_VALUE_LEN);
    if (Object.keys(env).length >= MAX_ENV_ENTRIES) break;
    env[key] = value;
  }
  return env;
}

/** Render an env map back into `KEY=VALUE` lines for the editor. */
function formatEnvLines(env) {
  if (!env || typeof env !== "object") return "";
  return Object.keys(env)
    .filter((k) => ENV_NAME_RE.test(k))
    .map((k) => `${k}=${env[k]}`)
    .join("\n");
}

/**
 * Coerce arbitrary input into a well-formed profile, or null if unusable.
 *
 * Deliberately permissive about env *values*: this is the read path used by
 * migration and API redaction, so it must load whatever is already on disk
 * rather than dropping it. The credential rule is enforced separately by
 * validateProfileEnv() on the save path.
 */
function normalizeProfile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id.trim().slice(0, 64) : "";
  if (!id) return null;
  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim().slice(0, MAX_NAME_LEN)
    : id;
  const command = typeof raw.command === "string"
    ? raw.command.trim().slice(0, MAX_COMMAND_LEN)
    : "";

  const env = {};
  const src = raw.env && typeof raw.env === "object" ? raw.env : {};
  for (const key of Object.keys(src)) {
    if (!ENV_NAME_RE.test(key)) continue;
    if (Object.keys(env).length >= MAX_ENV_ENTRIES) break;
    const value = src[key];
    if (typeof value !== "string") continue;
    env[key] = value.slice(0, MAX_ENV_VALUE_LEN);
  }

  return { id, name, command, env };
}

/**
 * Build the profile list for a settings object, migrating the legacy
 * `launchCommand` scalar on first run. Always returns at least one profile so
 * the UI and the default-id lookup never face an empty list.
 */
function migrateLaunchProfiles(settings) {
  const s = settings && typeof settings === "object" ? settings : {};

  let profiles = Array.isArray(s.launchProfiles)
    ? s.launchProfiles.map(normalizeProfile).filter(Boolean).slice(0, MAX_PROFILES)
    : [];

  // Drop duplicate ids, first occurrence wins.
  const seen = new Set();
  profiles = profiles.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  if (profiles.length === 0) {
    const legacy = typeof s.launchCommand === "string" && s.launchCommand.trim()
      ? s.launchCommand.trim()
      : "claude";
    profiles = [{ id: "default", name: "Default", command: legacy, env: {} }];
  }

  const wanted = typeof s.defaultLaunchProfileId === "string" ? s.defaultLaunchProfileId : "";
  const defaultLaunchProfileId = profiles.some((p) => p.id === wanted)
    ? wanted
    : profiles[0].id;

  return { launchProfiles: profiles, defaultLaunchProfileId };
}

/** Look up a profile by id, falling back to the configured default, then the first. */
function resolveLaunchProfile(profiles, profileId, defaultProfileId) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (list.length === 0) return null;
  return (
    list.find((p) => p && p.id === profileId) ||
    list.find((p) => p && p.id === defaultProfileId) ||
    list[0]
  );
}

/**
 * Expand a profile's env for `pty.spawn`. Returns a plain object of the
 * profile's own keys only — the caller layers it over `process.env`.
 */
function buildProfileEnv(profile, sourceEnv) {
  const out = {};
  if (!profile || !profile.env || typeof profile.env !== "object") return out;
  for (const key of Object.keys(profile.env)) {
    if (!ENV_NAME_RE.test(key)) continue;
    out[key] = expandEnvRefs(profile.env[key], sourceEnv);
  }
  return out;
}

/**
 * Redact profile env for responses leaving the process (the Local API).
 *
 * Pure `$VAR` references are names, not secrets, so they pass through — that
 * is what makes a misconfiguration debuggable over the API. Anything else
 * under a secret-shaped key name is replaced with `***`.
 */
function redactLaunchProfiles(profiles) {
  if (!Array.isArray(profiles)) return [];
  return profiles.map((p) => {
    const profile = normalizeProfile(p);
    if (!profile) return null;
    const env = {};
    for (const key of Object.keys(profile.env)) {
      const value = profile.env[key];
      env[key] = (!isPureEnvReference(value) && SECRETISH_KEY_RE.test(key)) ? "***" : value;
    }
    return { ...profile, env };
  }).filter(Boolean);
}

module.exports = {
  MAX_PROFILES,
  ENV_NAME_RE,
  expandEnvRefs,
  isPureEnvReference,
  containsEnvReference,
  isSecretishKey,
  validateProfileEnv,
  parseEnvLines,
  formatEnvLines,
  normalizeProfile,
  migrateLaunchProfiles,
  resolveLaunchProfile,
  buildProfileEnv,
  redactLaunchProfiles,
};
