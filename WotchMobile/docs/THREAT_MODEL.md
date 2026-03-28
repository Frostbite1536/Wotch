# Threat Model — Wotch Mobile

## Overview

**System Name**: Wotch Mobile + Bridge Server

**Version**: 0.1.0

**Last Updated**: 2026-03-28

---

## Purpose

This document identifies security threats to the Wotch Mobile system and its bridge server. The system connects a phone to a VPS shell over the internet, which is inherently security-sensitive.

---

## System Description

### What Are We Protecting?

**Primary Assets**:
| Asset | Description | Sensitivity |
|-------|-------------|-------------|
| VPS shell access | Full terminal session on the VPS | **Critical** |
| Bridge auth token | Shared secret for WebSocket auth | **Critical** |
| SSH profiles | Host, port, username (no passwords) | Medium |
| Terminal output | May contain sensitive data, paths, keys | High |

**Secondary Assets**:
| Asset | Description | Sensitivity |
|-------|-------------|-------------|
| App settings | Theme, preferences | Low |
| Known hosts | Host fingerprints (public data) | Low |

### Trust Boundaries

```
┌────────────────┐         ┌─────────────────┐         ┌──────────┐
│  iPhone App    │◄──TB-1──►│  Bridge Server  │◄──TB-2──►│  Shell   │
│  (untrusted    │  WebSocket│  (trusted VPS)  │  node-pty │  (VPS)   │
│   network)     │         │                 │          │          │
└────────────────┘         └─────────────────┘         └──────────┘
```

| Boundary | From | To | Data Crossing |
|----------|------|-----|---------------|
| TB-1 | Internet (phone) | Bridge Server (VPS) | Auth token, terminal I/O |
| TB-2 | Bridge Server | Shell (node-pty) | Raw terminal data |

---

## Threat Actors

| Actor | Motivation | Capability | Likelihood |
|-------|------------|------------|------------|
| **Network attacker** | VPS shell access | Intercept/modify WebSocket traffic | High (if no TLS) |
| **Lost/stolen phone** | Data access | Physical device access | Medium |
| **Malicious WiFi** | Credential theft | MitM on open networks | High (if no TLS) |
| **Brute force bot** | VPS access | Automated token guessing | Medium |

---

## STRIDE Threat Analysis

### Spoofing Threats

| ID | Threat | Target | Mitigation | Status |
|----|--------|--------|------------|--------|
| S-1 | Attacker connects to bridge with guessed token | Bridge Server | Token auth + constant-time compare | Implemented |
| S-2 | Attacker spoofs bridge server (MitM) | Phone App | TLS certificate validation | **Phase 3** |

### Tampering Threats

| ID | Threat | Target | Mitigation | Status |
|----|--------|--------|------------|--------|
| T-1 | MitM modifies terminal data in transit | WebSocket | TLS encryption | **Phase 3** |
| T-2 | Attacker injects commands into WebSocket stream | Bridge Server | Token auth required before data relay | Implemented |

### Repudiation Threats

| ID | Threat | Target | Mitigation | Status |
|----|--------|--------|------------|--------|
| R-1 | No audit trail of who connected when | Bridge Server | Connection logging with IP + timestamp | Implemented |

### Information Disclosure Threats

| ID | Threat | Target | Mitigation | Status |
|----|--------|--------|------------|--------|
| I-1 | Terminal data visible in transit (no TLS) | WebSocket | TLS encryption | **Phase 3** |
| I-2 | Token visible in transit during auth | WebSocket | TLS encryption | **Phase 3** |
| I-3 | Token extracted from phone storage | SecureStore | Hardware-backed Keychain encryption | Implemented |
| I-4 | Token logged to console | Server logs | Token truncated in logs | Implemented |

### Denial of Service Threats

| ID | Threat | Target | Mitigation | Status |
|----|--------|--------|------------|--------|
| D-1 | Connection flooding | Bridge Server | Max connections limit (default: 3) | Implemented |
| D-2 | Auth timeout exhaustion | Bridge Server | 10s auth timeout, close on expiry | Implemented |
| D-3 | Large payload flood | Bridge Server | node-pty handles buffering; no explicit limit | **Open issue** |

### Elevation of Privilege Threats

| ID | Threat | Target | Mitigation | Status |
|----|--------|--------|------------|--------|
| E-1 | Unauthenticated data relay | Bridge Server | Data messages ignored until auth succeeds | Implemented |
| E-2 | PTY spawns as root | VPS Shell | Bridge server runs as non-root user | Recommended, not enforced |

---

## Risk Assessment

| Rank | Threat ID | Risk Level | Status |
|------|-----------|------------|--------|
| 1 | I-1, I-2, T-1 | **Critical** (no TLS) | Phase 3 |
| 2 | S-2 | **High** (MitM possible) | Phase 3 |
| 3 | E-2 | **High** (root shell) | User responsibility |
| 4 | D-3 | **Medium** (payload flood) | Open |
| 5 | S-1 | **Low** (constant-time auth) | Implemented |

---

## Security Controls

### Preventive Controls

| Control | Protects Against | Implementation |
|---------|------------------|----------------|
| Token auth | Unauthorized access | `crypto.timingSafeEqual()` |
| SecureStore | Token theft from device | iOS Keychain (hardware-encrypted) |
| Auth timeout | Connection exhaustion | 10s timeout → close |
| Max connections | DoS | Default limit: 3 |
| Truncated token logging | Log exposure | `token.slice(0, 8) + "***"` |

### Detective Controls

| Control | Detects | Implementation |
|---------|---------|----------------|
| Connection logging | Unauthorized access attempts | `console.log` with IP + timestamp |

### Corrective Controls

| Control | Responds To | Implementation |
|---------|-------------|----------------|
| Auto-disconnect | Auth failure | `ws.close(4003)` |
| Token rotation | Compromise | Restart server with new `WOTCH_TOKEN` |

---

## Open Issues

1. **No TLS**: WebSocket traffic is unencrypted. Critical for Phase 3. Mitigation: use over trusted network or SSH tunnel until TLS is added.
2. **No payload size limit**: Large WebSocket messages could cause memory pressure.
3. **Bridge server runs as current user**: If that user is root, PTY sessions have root access. Document recommendation to run as non-root.
4. **No rate limiting on auth attempts**: A brute-force attack on the token is possible. Mitigated by long random tokens.

---

**Last Updated**: 2026-03-28
**Next Review**: After Phase 3 (TLS implementation)
