// Unit tests for src/launch-profiles.js
//
// Run with: npm test
//
// The security-relevant behaviour here is that profile env values hold
// *references* to secrets rather than secrets themselves (INV-SEC-020), so the
// expansion and redaction tests below are the load-bearing ones.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
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
} = require("../src/launch-profiles.js");

describe("expandEnvRefs", () => {
  const env = { OPENROUTER_API_KEY: "sk-or-secret", EMPTY: "", NESTED: "$OPENROUTER_API_KEY" };

  test("expands $NAME", () => {
    assert.equal(expandEnvRefs("$OPENROUTER_API_KEY", env), "sk-or-secret");
  });

  test("expands ${NAME}", () => {
    assert.equal(expandEnvRefs("${OPENROUTER_API_KEY}", env), "sk-or-secret");
  });

  test("expands a reference embedded in surrounding text", () => {
    assert.equal(expandEnvRefs("Bearer ${OPENROUTER_API_KEY}!", env), "Bearer sk-or-secret!");
  });

  test("unset variables expand to empty string", () => {
    assert.equal(expandEnvRefs("$NOT_SET", env), "");
    assert.equal(expandEnvRefs("a${NOT_SET}b", env), "ab");
  });

  test("$$ yields a literal dollar sign and is not treated as a reference", () => {
    assert.equal(expandEnvRefs("$$OPENROUTER_API_KEY", env), "$OPENROUTER_API_KEY");
    assert.equal(expandEnvRefs("$$", env), "$");
  });

  test("does not re-expand a value that itself contains a reference", () => {
    // Single-pass: guards against a hostile env var smuggling in another lookup.
    assert.equal(expandEnvRefs("$NESTED", env), "$OPENROUTER_API_KEY");
  });

  test("a lone $ or an invalid name is left alone", () => {
    assert.equal(expandEnvRefs("100$", env), "100$");
    assert.equal(expandEnvRefs("$1INVALID", env), "$1INVALID");
  });

  test("non-string input yields empty string", () => {
    assert.equal(expandEnvRefs(undefined, env), "");
    assert.equal(expandEnvRefs(42, env), "");
  });

  test("missing source env does not throw", () => {
    assert.equal(expandEnvRefs("$ANY", undefined), "");
  });
});

describe("isPureEnvReference", () => {
  test("true for reference-only values", () => {
    assert.equal(isPureEnvReference("$OPENROUTER_API_KEY"), true);
    assert.equal(isPureEnvReference("${A} ${B}"), true);
  });

  test("false for literals and mixed values", () => {
    assert.equal(isPureEnvReference("sk-or-v1-abc123"), false);
    assert.equal(isPureEnvReference("Bearer $TOKEN"), false);
    assert.equal(isPureEnvReference(""), false);
    assert.equal(isPureEnvReference(null), false);
  });
});

describe("containsEnvReference", () => {
  test("true when a real reference is present", () => {
    assert.equal(containsEnvReference("$TOKEN"), true);
    assert.equal(containsEnvReference("${TOKEN}"), true);
    assert.equal(containsEnvReference("Bearer $TOKEN"), true);
  });

  test("false for literals", () => {
    assert.equal(containsEnvReference("sk-or-v1-abc123"), false);
    assert.equal(containsEnvReference(""), false);
    assert.equal(containsEnvReference(null), false);
  });

  test("an escaped $$ is not a reference", () => {
    // "$$FOO" expands to the literal "$FOO", so it carries no lookup.
    assert.equal(containsEnvReference("$$FOO"), false);
    assert.equal(containsEnvReference("$$"), false);
  });

  test("an escape followed by a real reference still counts", () => {
    assert.equal(containsEnvReference("$$$FOO"), true);
  });
});

describe("isSecretishKey", () => {
  test("matches credential-shaped names", () => {
    for (const k of ["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "MY_SECRET", "DB_PASSWORD", "GH_CREDENTIAL"]) {
      assert.equal(isSecretishKey(k), true, k);
    }
  });

  test("does not match ordinary configuration", () => {
    for (const k of ["OPENAI_BASE_URL", "OPENAI_MODEL", "PATH", "CLAUDE_CODE_USE_OPENAI"]) {
      assert.equal(isSecretishKey(k), false, k);
    }
  });
});

describe("validateProfileEnv (INV-SEC-020 write boundary)", () => {
  test("rejects a literal credential under a secret-shaped key", () => {
    const err = validateProfileEnv({ OPENAI_API_KEY: "sk-or-v1-literalsecret" });
    assert.match(err, /OPENAI_API_KEY/);
    assert.match(err, /\$NAME/);
  });

  test("accepts a reference under the same key", () => {
    assert.equal(validateProfileEnv({ OPENAI_API_KEY: "$OPENROUTER_API_KEY" }), null);
    assert.equal(validateProfileEnv({ ANTHROPIC_AUTH_TOKEN: "${OPENROUTER_API_KEY}" }), null);
  });

  test("accepts an empty value so a variable can be cleared", () => {
    // The documented OpenRouter profile needs ANTHROPIC_API_KEY= to unset it.
    assert.equal(validateProfileEnv({ ANTHROPIC_API_KEY: "" }), null);
  });

  test("accepts a decorated reference — the secret still never hits disk", () => {
    assert.equal(validateProfileEnv({ AUTH_HEADER: "Bearer $TOKEN" }), null);
  });

  test("allows literal values under non-secret keys", () => {
    assert.equal(validateProfileEnv({
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      OPENAI_MODEL: "moonshotai/kimi-k3",
      CLAUDE_CODE_USE_OPENAI: "1",
    }), null);
  });

  test("rejects an escaped-dollar literal that only looks like a reference", () => {
    assert.notEqual(validateProfileEnv({ API_KEY: "$$NOT_A_REFERENCE" }), null);
  });

  test("validates the whole documented OpenRouter profile", () => {
    assert.equal(validateProfileEnv({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "$OPENROUTER_API_KEY",
      ANTHROPIC_API_KEY: "",
    }), null);
  });

  test("tolerates junk input", () => {
    assert.equal(validateProfileEnv(null), null);
    assert.equal(validateProfileEnv({ A: 5 }), null);
  });
});

describe("normalizeProfile stays permissive on the read path", () => {
  test("loads an existing literal rather than dropping it", () => {
    // Migration and API redaction both go through normalizeProfile; rejecting
    // here would silently rewrite a user's settings file.
    const p = normalizeProfile({ id: "x", env: { OPENAI_API_KEY: "sk-legacy-literal" } });
    assert.equal(p.env.OPENAI_API_KEY, "sk-legacy-literal");
    // ...but it is still redacted before leaving the process.
    assert.equal(redactLaunchProfiles([p])[0].env.OPENAI_API_KEY, "***");
  });
});

describe("parseEnvLines", () => {
  test("parses KEY=VALUE lines", () => {
    const env = parseEnvLines("ANTHROPIC_BASE_URL=https://openrouter.ai/api\nFOO=bar");
    assert.deepEqual(env, {
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      FOO: "bar",
    });
  });

  test("skips blanks and # comments", () => {
    assert.deepEqual(parseEnvLines("\n# a comment\nA=1\n\n"), { A: "1" });
  });

  test("keeps '=' inside the value", () => {
    assert.deepEqual(parseEnvLines("Q=a=b=c"), { Q: "a=b=c" });
  });

  test("trims whitespace around the assignment", () => {
    assert.deepEqual(parseEnvLines("  A  =  hello world  "), { A: "hello world" });
  });

  test("rejects invalid env var names", () => {
    assert.deepEqual(parseEnvLines("1BAD=x\nBAD-KEY=y\n=novalue\nOK=z"), { OK: "z" });
  });

  test("non-string input yields an empty map", () => {
    assert.deepEqual(parseEnvLines(undefined), {});
  });
});

describe("formatEnvLines", () => {
  test("round-trips through parseEnvLines", () => {
    const env = { A: "1", B: "$SECRET" };
    assert.deepEqual(parseEnvLines(formatEnvLines(env)), env);
  });

  test("handles empty and invalid input", () => {
    assert.equal(formatEnvLines({}), "");
    assert.equal(formatEnvLines(null), "");
  });
});

describe("normalizeProfile", () => {
  test("returns null without a usable id", () => {
    assert.equal(normalizeProfile(null), null);
    assert.equal(normalizeProfile({}), null);
    assert.equal(normalizeProfile({ id: "   " }), null);
  });

  test("falls back to the id when no name is given", () => {
    assert.equal(normalizeProfile({ id: "kimi" }).name, "kimi");
  });

  test("drops env keys that are not valid variable names", () => {
    const p = normalizeProfile({ id: "x", env: { GOOD: "1", "BAD-KEY": "2", "9BAD": "3" } });
    assert.deepEqual(p.env, { GOOD: "1" });
  });

  test("drops non-string env values", () => {
    const p = normalizeProfile({ id: "x", env: { A: "ok", B: 5, C: null } });
    assert.deepEqual(p.env, { A: "ok" });
  });

  test("truncates an over-long command", () => {
    const p = normalizeProfile({ id: "x", command: "c".repeat(900) });
    assert.equal(p.command.length, 500);
  });
});

describe("migrateLaunchProfiles", () => {
  test("synthesizes a profile from the legacy launchCommand", () => {
    const { launchProfiles, defaultLaunchProfileId } = migrateLaunchProfiles({
      launchCommand: "openclaude",
    });
    assert.equal(launchProfiles.length, 1);
    assert.equal(launchProfiles[0].command, "openclaude");
    assert.equal(defaultLaunchProfileId, launchProfiles[0].id);
  });

  test("defaults to claude when there is no legacy command", () => {
    assert.equal(migrateLaunchProfiles({}).launchProfiles[0].command, "claude");
  });

  test("never returns an empty list", () => {
    assert.equal(migrateLaunchProfiles({ launchProfiles: [] }).launchProfiles.length, 1);
    assert.equal(migrateLaunchProfiles(undefined).launchProfiles.length, 1);
  });

  test("preserves existing profiles and drops duplicate ids", () => {
    const { launchProfiles } = migrateLaunchProfiles({
      launchProfiles: [
        { id: "a", name: "First", command: "claude" },
        { id: "a", name: "Duplicate", command: "other" },
        { id: "b", name: "Second", command: "kimi" },
      ],
    });
    assert.deepEqual(launchProfiles.map((p) => p.id), ["a", "b"]);
    assert.equal(launchProfiles[0].name, "First");
  });

  test("repairs a defaultLaunchProfileId that points at nothing", () => {
    const { defaultLaunchProfileId } = migrateLaunchProfiles({
      launchProfiles: [{ id: "a", command: "claude" }],
      defaultLaunchProfileId: "ghost",
    });
    assert.equal(defaultLaunchProfileId, "a");
  });

  test("honours a valid defaultLaunchProfileId", () => {
    const { defaultLaunchProfileId } = migrateLaunchProfiles({
      launchProfiles: [{ id: "a", command: "claude" }, { id: "b", command: "kimi" }],
      defaultLaunchProfileId: "b",
    });
    assert.equal(defaultLaunchProfileId, "b");
  });
});

describe("resolveLaunchProfile", () => {
  const profiles = [{ id: "a", command: "claude" }, { id: "b", command: "kimi" }];

  test("finds an explicit id", () => {
    assert.equal(resolveLaunchProfile(profiles, "b", "a").id, "b");
  });

  test("falls back to the default when the id is unknown", () => {
    assert.equal(resolveLaunchProfile(profiles, "ghost", "b").id, "b");
  });

  test("falls back to the first profile when neither matches", () => {
    assert.equal(resolveLaunchProfile(profiles, "ghost", "also-ghost").id, "a");
  });

  test("returns null for an empty list", () => {
    assert.equal(resolveLaunchProfile([], "a", "a"), null);
    assert.equal(resolveLaunchProfile(undefined, "a", "a"), null);
  });
});

describe("buildProfileEnv", () => {
  test("expands references against the supplied environment", () => {
    const profile = {
      id: "kimi",
      env: { ANTHROPIC_AUTH_TOKEN: "$OPENROUTER_API_KEY", ANTHROPIC_API_KEY: "" },
    };
    assert.deepEqual(buildProfileEnv(profile, { OPENROUTER_API_KEY: "sk-or-x" }), {
      ANTHROPIC_AUTH_TOKEN: "sk-or-x",
      ANTHROPIC_API_KEY: "",
    });
  });

  test("returns an empty map for a profile with no env", () => {
    assert.deepEqual(buildProfileEnv({ id: "a" }, {}), {});
    assert.deepEqual(buildProfileEnv(null, {}), {});
  });
});

describe("redactLaunchProfiles", () => {
  test("redacts a literal secret under a secret-shaped key", () => {
    const [p] = redactLaunchProfiles([
      { id: "x", env: { OPENROUTER_API_KEY: "sk-or-v1-literal" } },
    ]);
    assert.equal(p.env.OPENROUTER_API_KEY, "***");
  });

  test("passes through a pure reference under the same key", () => {
    const [p] = redactLaunchProfiles([
      { id: "x", env: { ANTHROPIC_AUTH_TOKEN: "$OPENROUTER_API_KEY" } },
    ]);
    assert.equal(p.env.ANTHROPIC_AUTH_TOKEN, "$OPENROUTER_API_KEY");
  });

  test("passes through non-secret configuration", () => {
    const [p] = redactLaunchProfiles([
      { id: "x", env: { ANTHROPIC_BASE_URL: "https://openrouter.ai/api" } },
    ]);
    assert.equal(p.env.ANTHROPIC_BASE_URL, "https://openrouter.ai/api");
  });

  test("keeps id, name and command intact", () => {
    const [p] = redactLaunchProfiles([{ id: "x", name: "Kimi", command: "claude" }]);
    assert.deepEqual(p, { id: "x", name: "Kimi", command: "claude", env: {} });
  });

  test("tolerates junk input", () => {
    assert.deepEqual(redactLaunchProfiles(undefined), []);
    assert.deepEqual(redactLaunchProfiles([null, {}, { id: "ok" }]).map((p) => p.id), ["ok"]);
  });
});
