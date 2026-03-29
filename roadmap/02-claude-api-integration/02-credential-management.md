# Credential Management

## Overview

The Anthropic API key is the single most sensitive piece of data in Wotch. It must be encrypted at rest, never exposed to the renderer process, never logged, and never stored in `settings.json`. This document specifies the encryption scheme, storage format, validation flow, and fallback behavior.

---

## Storage Location

```
~/.wotch/credentials
```

This is a single binary file (Base64-encoded) containing the encrypted API key. It is **not** JSON — it is an opaque blob that only the main process can decrypt.

File permissions: `0o600` (owner read/write only).

---

## Encryption Scheme

### Primary: Electron safeStorage API

Electron's `safeStorage` module uses the OS keychain (macOS Keychain, Windows DPAPI, Linux libsecret/gnome-keyring) to encrypt data. This is the preferred method.

```javascript
const { safeStorage } = require("electron");

// Encrypt
const encrypted = safeStorage.encryptString(apiKey);
// encrypted is a Buffer

// Write to disk as Base64
fs.writeFileSync(credentialsPath, encrypted.toString("base64"), { mode: 0o600 });

// Read and decrypt
const raw = fs.readFileSync(credentialsPath, "utf-8");
const decrypted = safeStorage.decryptString(Buffer.from(raw, "base64"));
```

**Availability check:**

```javascript
safeStorage.isEncryptionAvailable()
```

This returns `true` on:
- macOS (always, Keychain is always available)
- Windows (always, DPAPI is always available)
- Linux with a keyring running (gnome-keyring, kwallet, or the Secret Service API)

### Fallback: AES-256-GCM with Machine-Derived Key

On Linux systems without a keyring (headless, minimal desktop, some WSL environments), `safeStorage` is unavailable. The fallback uses Node.js `crypto` with a deterministic machine-derived key.

**Key derivation:**

```javascript
const crypto = require("crypto");
const os = require("os");

function deriveFallbackKey() {
  // Combine machine identifiers that are stable across reboots
  // but unique per machine. This is NOT a substitute for a real keychain —
  // it provides obfuscation, not true security.
  const material = [
    os.hostname(),
    os.homedir(),
    os.userInfo().username,
    // On Linux, read /etc/machine-id if available
    tryReadFile("/etc/machine-id") || "no-machine-id",
  ].join("|");

  return crypto.pbkdf2Sync(material, "wotch-credential-salt", 100000, 32, "sha256");
}

function tryReadFile(filePath) {
  try { return fs.readFileSync(filePath, "utf-8").trim(); } catch { return null; }
}
```

**Encrypt (fallback):**

```javascript
function encryptFallback(plaintext, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: version(1) + iv(16) + authTag(16) + ciphertext(variable)
  const result = Buffer.alloc(1 + 16 + 16 + encrypted.length);
  result[0] = 0x02; // version byte: 0x02 = fallback encryption
  iv.copy(result, 1);
  authTag.copy(result, 17);
  encrypted.copy(result, 33);

  return result.toString("base64");
}
```

**Decrypt (fallback):**

```javascript
function decryptFallback(base64Data, key) {
  const data = Buffer.from(base64Data, "base64");
  if (data[0] !== 0x02) throw new Error("Unknown credential format");

  const iv = data.subarray(1, 17);
  const authTag = data.subarray(17, 33);
  const ciphertext = data.subarray(33);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, null, "utf8") + decipher.final("utf8");
}
```

### Format Detection

The credentials file uses a version prefix to determine which decryption method to use:

| First byte of decoded buffer | Meaning |
|------------------------------|---------|
| `0x02` | Fallback AES-256-GCM encryption |
| Anything else | Electron safeStorage encryption (opaque format) |

When reading, the CredentialManager tries `safeStorage.decryptString()` first. If that fails (wrong platform, keychain changed), it falls back to checking for the `0x02` prefix and using AES-256-GCM.

---

## CredentialManager Class

```javascript
class CredentialManager {
  constructor(credentialsPath) {
    this.credentialsPath = credentialsPath; // ~/.wotch/credentials
    this.fallbackKey = null; // lazily derived
    this.cachedKey = null;   // decrypted key held in memory (main process only)
  }

  /**
   * Check if a key is stored.
   * Exposed via IPC as claude-has-key.
   */
  hasKey() {
    return fs.existsSync(this.credentialsPath);
  }

  /**
   * Store an API key, encrypted.
   * Exposed via IPC as claude-set-api-key.
   * @param {string} apiKey - The raw API key (sk-ant-...)
   */
  setKey(apiKey) {
    if (!apiKey || !apiKey.startsWith("sk-ant-")) {
      throw new Error("Invalid API key format");
    }

    let encoded;
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(apiKey);
      encoded = encrypted.toString("base64");
    } else {
      if (!this.fallbackKey) this.fallbackKey = deriveFallbackKey();
      encoded = encryptFallback(apiKey, this.fallbackKey);
    }

    const dir = path.dirname(this.credentialsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.credentialsPath, encoded, { encoding: "utf-8", mode: 0o600 });

    this.cachedKey = apiKey;
  }

  /**
   * Retrieve the decrypted API key.
   * NEVER exposed via IPC — main process only.
   * @returns {string|null}
   */
  getKey() {
    if (this.cachedKey) return this.cachedKey;
    if (!this.hasKey()) return null;

    try {
      const raw = fs.readFileSync(this.credentialsPath, "utf-8");
      const buf = Buffer.from(raw, "base64");

      // Try safeStorage first
      if (safeStorage.isEncryptionAvailable()) {
        try {
          this.cachedKey = safeStorage.decryptString(buf);
          return this.cachedKey;
        } catch {
          // safeStorage failed — maybe the file was written with fallback
        }
      }

      // Try fallback decryption
      if (buf[0] === 0x02) {
        if (!this.fallbackKey) this.fallbackKey = deriveFallbackKey();
        this.cachedKey = decryptFallback(raw, this.fallbackKey);
        return this.cachedKey;
      }

      // If safeStorage is unavailable and file doesn't have fallback prefix,
      // the credentials were written on a different machine or with a keychain
      // that's no longer available.
      console.log("[wotch] Cannot decrypt credentials — keychain unavailable");
      return null;
    } catch (err) {
      console.log("[wotch] Failed to decrypt credentials:", err.message);
      return null;
    }
  }

  /**
   * Delete the stored API key.
   * Exposed via IPC as claude-delete-key.
   */
  deleteKey() {
    this.cachedKey = null;
    try {
      if (fs.existsSync(this.credentialsPath)) {
        fs.unlinkSync(this.credentialsPath);
      }
    } catch (err) {
      console.log("[wotch] Failed to delete credentials:", err.message);
    }
  }

  /**
   * Validate an API key by making a minimal API call.
   * Exposed via IPC as claude-validate-key.
   * @param {string} apiKey - The key to validate (or null to validate stored key)
   * @returns {{ valid: boolean, error?: string }}
   */
  async validateKey(apiKey) {
    const key = apiKey || this.getKey();
    if (!key) return { valid: false, error: "No API key provided" };

    try {
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: key });

      // Make a minimal request to verify the key
      await client.messages.create({
        model: "claude-haiku-4-20250514",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });

      return { valid: true };
    } catch (err) {
      if (err.status === 401) {
        return { valid: false, error: "Invalid API key" };
      }
      if (err.status === 403) {
        return { valid: false, error: "API key lacks required permissions" };
      }
      return { valid: false, error: `Validation failed: ${err.message}` };
    }
  }

  /**
   * Clear cached key from memory.
   * Called on app quit.
   */
  clearCache() {
    this.cachedKey = null;
  }
}
```

---

## API Key Validation Flow

```
User enters API key in settings UI
            │
            ▼
Renderer: window.wotch.claude.setApiKey(key)
            │
            ▼ IPC: claude-set-api-key
            │
Main: CredentialManager.setKey(key)    ← encrypts and writes
            │
            ▼
Main: CredentialManager.validateKey(key)  ← makes test API call
            │
        ┌───┴───┐
        │       │
     valid    invalid
        │       │
        ▼       ▼
  Return      Return error,
  { valid:    delete stored key
    true }    { valid: false,
                error: "..." }
            │
            ▼
Renderer: Show checkmark    OR    Show error message,
          or error icon           prompt to re-enter
```

**Important:** The key is stored *before* validation so that if validation fails due to a transient network error, the key isn't lost. If validation returns `{ valid: false, error: "Invalid API key" }` (401 specifically), the key is deleted automatically.

---

## Key Rotation

When a user enters a new key while one already exists:

1. The new key overwrites the old credentials file.
2. The old key is immediately unrecoverable.
3. The new key is validated.
4. Active conversations continue with the new key (no restart needed).
5. The `ClaudeAPIManager` recreates its Anthropic client with the new key on the next `sendMessage()` call.

---

## Secure Memory Handling

- The decrypted key is held in `this.cachedKey` (a JavaScript string) in the main process only.
- On app quit (`will-quit` event), `CredentialManager.clearCache()` is called to null the reference.
- JavaScript strings are immutable and GC-managed — we cannot securely wipe memory. This is an inherent limitation of the Electron/Node.js platform. The mitigation is that the main process memory is not accessible from the renderer (context isolation) and not directly accessible from other OS processes without elevated privileges.
- The API key is never:
  - Logged (not even at debug level)
  - Included in error messages
  - Sent to the renderer
  - Written to `settings.json`
  - Included in crash reports

---

## What Happens If the OS Keychain Is Unavailable

| Platform | Keychain | Behavior |
|----------|----------|----------|
| macOS | Keychain Services | Always available. `safeStorage` works. |
| Windows | DPAPI | Always available. `safeStorage` works. |
| Linux + GNOME | gnome-keyring | `safeStorage` works if gnome-keyring is running. |
| Linux + KDE | kwallet | `safeStorage` works if kwallet is running. |
| Linux (minimal) | None | `safeStorage.isEncryptionAvailable()` returns false. Fallback to AES-256-GCM. |
| WSL | Varies | Usually no keyring. Fallback to AES-256-GCM. |

When using the fallback:
- A one-time warning is logged: `[wotch] OS keychain unavailable, using fallback encryption`
- The settings UI shows a note: "API key is encrypted with machine-local key (OS keychain unavailable)"
- The key is still encrypted on disk — just with a weaker key derivation scheme

If a user moves their `~/.wotch/credentials` file to a different machine, it will fail to decrypt (different machine-id, hostname, etc.). This is expected and intentional.

---

## New Invariants

### INV-SEC-006: API Key Encryption at Rest

The Anthropic API key must always be encrypted before writing to disk. It must never be stored in plaintext in any file. The `~/.wotch/credentials` file must contain only the encrypted (Base64-encoded) key, never the raw key.

**Rationale:** An API key stored in plaintext would be trivially stolen by any process with read access to the user's home directory.

**Enforcement:** `CredentialManager.setKey()` always encrypts. No other code path writes to the credentials file.

### INV-SEC-007: API Key Never in Renderer

The decrypted API key must never be sent to the renderer process via IPC. The `getKey()` method must not have an IPC handler. The renderer can only check `hasKey()` (boolean) and call `setKey()`/`deleteKey()`/`validateKey()`.

**Rationale:** The renderer is the less-trusted process (it renders terminal output that could theoretically be crafted). If the renderer had the API key, a compromised renderer could exfiltrate it.

**Enforcement:** Code review of `preload.js` and IPC handlers. No IPC handler returns the decrypted key.

---

## IPC Handlers (main.js additions)

```javascript
// ── Claude API: Credential Management ────────────────────────────
const CREDENTIALS_PATH = path.join(SETTINGS_DIR, "credentials");
const credentialManager = new CredentialManager(CREDENTIALS_PATH);

ipcMain.handle("claude-set-api-key", async (_event, { apiKey }) => {
  try {
    credentialManager.setKey(apiKey);
    const validation = await credentialManager.validateKey(apiKey);
    if (!validation.valid && validation.error === "Invalid API key") {
      credentialManager.deleteKey();
    }
    return validation;
  } catch (err) {
    return { valid: false, error: err.message };
  }
});

ipcMain.handle("claude-validate-key", async () => {
  return credentialManager.validateKey();
});

ipcMain.handle("claude-has-key", () => {
  return credentialManager.hasKey();
});

ipcMain.handle("claude-delete-key", () => {
  credentialManager.deleteKey();
  return { success: true };
});
```

---

## Settings UI Addition

In the settings overlay (`index.html`), add a new section after "Shell":

```html
<div class="settings-section">
  <div class="settings-section-title">Claude API</div>
  <div class="setting-row">
    <div>
      <div class="setting-label">API Key</div>
      <div class="setting-hint" id="api-key-hint">Not configured</div>
    </div>
    <div style="display:flex;gap:6px;align-items:center;">
      <input type="password" id="set-api-key" class="setting-input"
             placeholder="sk-ant-..." style="width:200px;" />
      <button id="btn-save-api-key" class="btn-small">Save</button>
      <button id="btn-delete-api-key" class="btn-small btn-danger"
              style="display:none;">Delete</button>
    </div>
  </div>
  <div class="setting-row" id="api-key-status-row" style="display:none;">
    <div>
      <div class="setting-label">Status</div>
    </div>
    <div id="api-key-status" class="setting-status"></div>
  </div>
  <div class="setting-row">
    <div>
      <div class="setting-label">Daily budget</div>
      <div class="setting-hint">Maximum daily API spend (USD)</div>
    </div>
    <input type="number" id="set-daily-budget" class="setting-input"
           placeholder="No limit" min="0" step="0.50" style="width:80px;" />
  </div>
</div>
```

The renderer.js code for this section:

```javascript
const apiKeyInput = document.getElementById("set-api-key");
const btnSaveApiKey = document.getElementById("btn-save-api-key");
const btnDeleteApiKey = document.getElementById("btn-delete-api-key");
const apiKeyHint = document.getElementById("api-key-hint");
const apiKeyStatus = document.getElementById("api-key-status");
const apiKeyStatusRow = document.getElementById("api-key-status-row");

async function checkApiKeyStatus() {
  const hasKey = await window.wotch.claude.hasKey();
  if (hasKey) {
    apiKeyHint.textContent = "API key is configured";
    apiKeyHint.style.color = "var(--green)";
    apiKeyInput.placeholder = "••••••••••••••••";
    apiKeyInput.value = "";
    btnDeleteApiKey.style.display = "inline-block";
  } else {
    apiKeyHint.textContent = "Not configured";
    apiKeyHint.style.color = "var(--text-muted)";
    apiKeyInput.placeholder = "sk-ant-...";
    btnDeleteApiKey.style.display = "none";
  }
}

btnSaveApiKey.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;

  btnSaveApiKey.textContent = "Validating...";
  btnSaveApiKey.disabled = true;

  const result = await window.wotch.claude.setApiKey(key);

  apiKeyStatusRow.style.display = "flex";
  if (result.valid) {
    apiKeyStatus.textContent = "Valid — key saved";
    apiKeyStatus.style.color = "var(--green)";
    apiKeyInput.value = "";
  } else {
    apiKeyStatus.textContent = result.error;
    apiKeyStatus.style.color = "#f87171";
  }

  btnSaveApiKey.textContent = "Save";
  btnSaveApiKey.disabled = false;
  checkApiKeyStatus();
});

btnDeleteApiKey.addEventListener("click", async () => {
  await window.wotch.claude.deleteKey();
  checkApiKeyStatus();
  apiKeyStatusRow.style.display = "none";
  showToast("API key deleted", "info");
});
```
