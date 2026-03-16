# Security Audit Report — Claude Relay Service

**Date:** 2026-02-26
**Scope:** Full codebase (`src/`, `config/`, `cli/`, `scripts/`, `web/`, `package.json`, `Dockerfile`)
**Auditor:** Claude Opus 4.6 (automated static analysis)
**Commit:** `af0a73b` (branch: `fix/allow-opus-for-free-accounts`)

---

## Executive Summary

A comprehensive security audit was performed across four dimensions: **data exfiltration**, **backdoors / authentication bypass**, **credential theft / token mishandling**, and **obfuscated code / supply chain**. Approximately 150+ JavaScript source files, all configuration files, build scripts, and Docker artifacts were examined.

**Verdict: No malicious behavior detected.**
The project contains no backdoors, no hidden data exfiltration channels, and no code designed to steal user accounts or credentials. Several security hygiene issues were identified and are documented below.

---

## Audit Dimensions & Coverage

| Dimension | Files Examined | Techniques Used |
|-----------|---------------|-----------------|
| Data Exfiltration | All `src/`, `config/`, `scripts/`, `cli/` | Traced every HTTP/HTTPS call, checked for hardcoded URLs/IPs, base64-encoded endpoints, DNS exfiltration patterns |
| Backdoors & Auth Bypass | `src/middleware/auth.js`, all route files, `apiKeyService.js`, `config.js`, `data/init.json` | Searched for hardcoded credentials, auth bypass logic, hidden routes, eval/Function usage |
| Credential Theft | All service files, `logger.js`, `tokenMask.js`, `oauthHelper.js` | Verified encryption implementation, checked logging for token leaks, validated hashing |
| Obfuscation & Supply Chain | `package.json`, `Dockerfile`, `docker-entrypoint.sh`, `Makefile`, git hooks | Checked npm lifecycle scripts, child_process usage, dynamic code execution, dependency legitimacy |

---

## 1. Malicious Behavior Analysis

### 1.1 Data Exfiltration — NONE FOUND

All outbound network requests target legitimate upstream APIs only:

| Destination | Purpose |
|-------------|---------|
| `api.anthropic.com` | Claude API |
| `generativelanguage.googleapis.com` | Google Gemini API |
| `api.openai.com` | OpenAI API |
| `api.github.com` | Version checking |
| `api.telegram.org` | User-configured notifications |
| `api.day.app` | User-configured Bark notifications |
| `api.workos.com` | WorkOS auth (Droid accounts) |
| `api.factory.ai` | Factory AI (Droid accounts) |
| `cloudcode-pa.googleapis.com` | Antigravity (legitimate Anthropic service) |

- No hardcoded suspicious URLs or IP addresses
- No base64-encoded obfuscated endpoints
- No DNS exfiltration patterns
- No beacon, tracking, or analytics code
- No hidden background data collection

### 1.2 Backdoors & Authentication Bypass — NONE FOUND

- All admin routes require `authenticateAdmin` middleware
- All API routes require `authenticateApiKey` middleware
- No hardcoded master keys or bypass tokens
- No hidden admin routes or undocumented endpoints
- No default hidden user accounts created at startup
- JWT validation is properly implemented

### 1.3 Obfuscated / Malicious Code — NONE FOUND

- No `eval()` or `new Function()` calls
- No obfuscated variable names or code blocks
- No remote script download and execution
- No malicious npm lifecycle hooks (`postinstall`, `preinstall`, `prepare`)
- All git hooks are disabled (`.sample` files only)
- No WebSocket connections to unknown servers
- All `setInterval`/`setTimeout` calls serve legitimate purposes (cache cleanup, rate limit reset, health checks)

### 1.4 Supply Chain — CLEAN

All dependencies are well-known, legitimate packages:
- `express`, `axios`, `ioredis`, `helmet`, `cors`, `winston`, `nodemailer`, `bcryptjs`, `jsonwebtoken`, `google-auth-library`, `@aws-sdk/*`, etc.
- No obfuscation tools, reverse shells, crypto miners, or data exfiltration packages

### 1.5 Positive Security Practices Observed

- AES-256-CBC encryption for sensitive data at rest (OAuth tokens, credentials)
- `scryptSync` key derivation for encryption keys
- `bcryptjs` (10 rounds) for admin password hashing
- SHA-256 hashing for API keys
- Token masking utility (`tokenMask.js`) for log sanitization
- `AbortController` cleanup on client disconnect
- `helmet` security headers
- CORS configuration
- Redis-based concurrent request control
- Automatic cleanup of stale concurrency counters

---

## 2. Security Hygiene Findings

While no malicious behavior was found, the following security improvement opportunities were identified.

### 2.1 HIGH — OAuth Tokens Logged in Plaintext

**Location:** `src/utils/logger.js:420-439`
**Affected calls:**
- `src/services/account/claudeAccountService.js:316` — `logger.authDetail('Token refresh response', response.data)`
- `src/utils/oauthHelper.js:205` — `logger.authDetail('OAuth token exchange response', response.data)`
- `src/utils/oauthHelper.js:425` — `logger.authDetail('Setup Token exchange response', response.data)`

**Description:** The `logger.authDetail()` function writes the complete `response.data` object — including unmasked `access_token` and `refresh_token` — to `logs/claude-relay-auth-detail-YYYY-MM-DD.log`. Anyone with filesystem access to the logs directory can extract valid OAuth tokens.

**Recommendation:** Either remove the `authDetail` logger entirely, or apply `tokenMask` to all sensitive fields before logging. Consider making this logger opt-in via an environment variable.

### 2.2 HIGH — Hardcoded Encryption Salt

**Location:** `src/services/account/claudeAccountService.js:55`

**Description:** The AES encryption salt is hardcoded as the string `'salt'` rather than being a random value per encryption operation. Combined with a potentially weak `ENCRYPTION_KEY` environment variable, this reduces the effective security of the encryption.

**Recommendation:** Use a random salt per encryption operation (store alongside the ciphertext), or at minimum make the salt configurable via environment variable.

### 2.3 HIGH — Admin Password Stored in Plaintext in init.json

**Location:** `src/routes/web.js:226`

**Description:** When the admin password is changed, the new password is written in plaintext to `data/init.json`. While Redis stores a proper bcrypt hash, the init.json file retains the cleartext password on disk.

**Recommendation:** Only store the bcrypt hash in `init.json`, or remove password persistence from the file entirely after initial setup.

### 2.4 MEDIUM — API Key Hashing Uses Static Salt

**Location:** `src/services/apiKeyService.js:2116-2121`

**Description:** API keys are hashed using `SHA-256 + config.security.encryptionKey` as a static salt. This is weaker than per-key random salts or purpose-built algorithms (bcrypt, argon2). If `encryptionKey` is compromised, offline brute-force attacks become feasible.

**Recommendation:** Consider using bcrypt or argon2 for API key hashing, or at minimum use per-key random salts.

### 2.5 MEDIUM — CSP Includes `unsafe-eval` and `unsafe-inline`

**Location:** `src/middleware/auth.js:1891`

**Description:** The Content Security Policy header includes `'unsafe-eval'` and `'unsafe-inline'` for script sources (to support Tailwind CSS compilation). This significantly reduces protection against XSS attacks on the admin web interface.

**Recommendation:** Pre-compile Tailwind CSS at build time to eliminate the need for `unsafe-eval`. Use nonce-based CSP for inline scripts.

### 2.6 MEDIUM — Balance Script VM Sandbox

**Location:** `src/services/balanceScriptService.js`

**Description:** User-provided balance scripts are executed via Node.js `vm.Script`, which is not a true security sandbox. While the feature is disabled by default (`BALANCE_SCRIPT_ENABLED=true` required) and includes SSRF protections, VM escape is possible for determined attackers with admin access.

**Recommendation:** If this feature is needed, use `isolated-vm` or worker threads with restricted permissions.

### 2.7 MEDIUM — Redis Connection Defaults to No TLS

**Location:** `config/config.js`

**Description:** Redis connection does not enable TLS by default. On shared networks, credentials and encrypted data in transit could be intercepted.

**Recommendation:** Enable TLS for Redis connections in production (`enableTLS: true`), or document this as a deployment requirement.

### 2.8 MEDIUM — No Rate Limiting on Admin Login

**Location:** `src/routes/web.js` (login endpoint)

**Description:** The admin login endpoint does not implement rate limiting, making it susceptible to brute-force attacks.

**Recommendation:** Add rate limiting (e.g., max 5 attempts per minute per IP) to the admin login endpoint.

### 2.9 LOW — Weak Default Configuration Values

**Location:** `config/config.example.js:14-18`

**Description:** Default secret values like `'CHANGE-THIS-JWT-SECRET-IN-PRODUCTION'` are used as fallbacks. If environment variables are not properly set, the service runs with predictable secrets.

**Recommendation:** Refuse to start the service if critical secrets (`JWT_SECRET`, `ENCRYPTION_KEY`) are not explicitly configured. Log a clear error message at startup.

### 2.10 LOW — User Email Logged in Info Level

**Location:** `src/services/account/claudeAccountService.js:2107-2112`

**Description:** User email addresses appear in standard info-level logs during profile fetch, which could aid account enumeration if logs are exposed.

**Recommendation:** Mask or omit email addresses from info-level logs.

### 2.11 LOW — Deprecated Crypto API Usage

**Location:** `src/services/account/claudeAccountService.js:1221`

**Description:** Legacy backward-compatibility code uses the deprecated `crypto.createDecipher()` (without IV). This is cryptographically weaker and will fail on newer Node.js versions.

**Recommendation:** Migrate all legacy encrypted data to the IV-based `createDecipheriv` format, then remove the deprecated fallback.

---

## 3. Summary Table

| ID | Severity | Category | Issue | Malicious? |
|----|----------|----------|-------|------------|
| 2.1 | HIGH | Credential Leak | OAuth tokens logged in plaintext | No |
| 2.2 | HIGH | Cryptography | Hardcoded encryption salt | No |
| 2.3 | HIGH | Credential Storage | Admin password plaintext in init.json | No |
| 2.4 | MEDIUM | Cryptography | API key hashing with static salt | No |
| 2.5 | MEDIUM | Web Security | CSP allows unsafe-eval | No |
| 2.6 | MEDIUM | Sandboxing | vm.Script is not a true sandbox | No |
| 2.7 | MEDIUM | Network | Redis defaults to no TLS | No |
| 2.8 | MEDIUM | Authentication | No rate limit on admin login | No |
| 2.9 | LOW | Configuration | Weak default secrets | No |
| 2.10 | LOW | Information Leak | User email in logs | No |
| 2.11 | LOW | Cryptography | Deprecated crypto API | No |

---

## 4. Conclusion

**The Claude Relay Service codebase is free of malicious code.** There are no backdoors, no data exfiltration mechanisms, no hidden credential theft, and no supply chain compromises. The project demonstrates generally solid security practices including encryption at rest, proper authentication middleware, token masking, and secure header configuration.

The 11 findings above are standard security hygiene issues commonly found in production Node.js applications. The most urgent items to address are:

1. **Remove or sanitize plaintext token logging** (Finding 2.1)
2. **Use random salts for encryption** (Finding 2.2)
3. **Stop storing admin password in plaintext** (Finding 2.3)

None of these issues indicate malicious intent — they are engineering improvement opportunities.

---

*This report was generated through automated static analysis. It does not replace a manual penetration test or runtime security assessment.*
