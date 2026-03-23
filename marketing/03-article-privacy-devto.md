---
title: "Privacy-First AI Log Analysis: Filtering PII Before It Reaches the LLM"
published: false
description: How LogPulse AI strips IP addresses, emails, credentials, and 8 more PII categories from log events before they're sent to any LLM — and why every AI-powered security tool should do this
tags: security, ai, privacy, opensource
cover_image: https://raw.githubusercontent.com/PhilipLykov/LogPulseAI/master/docs/screenshots/privacy-settings.png
---

If you're using AI to analyze your logs, you're almost certainly sending sensitive data to a third-party API. IP addresses, email addresses, hostnames, API keys, usernames — all embedded in the log messages themselves.

Most AI-powered log analysis tools don't address this. They send raw log content straight to the LLM.

I built **LogPulse AI** — an open-source SIEM — with a different approach: a configurable PII filtering pipeline that runs **before** any data leaves your server.

## What's Actually in Your Logs

Let's look at a typical syslog event:

```
Mar 5 10:15:32 prod-web-01 sshd[4521]: Failed password for admin from 203.0.113.42 port 52341 ssh2
```

This single line contains:
- A **hostname** (`prod-web-01`) — reveals your infrastructure
- A **username** (`admin`) — reveals account names
- An **IP address** (`203.0.113.42`) — PII in many jurisdictions (GDPR explicitly classifies IPs as personal data)
- A **service name** and port — reveals your attack surface

Now imagine sending thousands of these to OpenAI's API every hour. You're leaking your entire infrastructure topology and every authentication attempt to a third party.

## The Filtering Pipeline

LogPulse AI applies PII filtering at ingest time, before events enter the AI scoring pipeline. Here's what it catches:

### 11 Built-in Categories

| Category | Pattern | Example → Masked |
|----------|---------|-----------------|
| IP Addresses (v4/v6) | `\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b` | `203.0.113.42` → `[IP]` |
| Email Addresses | Standard RFC 5322 | `admin@corp.com` → `[EMAIL]` |
| Phone Numbers | International formats | `+1-555-0123` → `[PHONE]` |
| URLs | http/https with paths | `https://internal.corp/api/v2` → `[URL]` |
| MAC Addresses | Colon/dash/dot separated | `AA:BB:CC:DD:EE:FF` → `[MAC]` |
| Credit Card Numbers | Luhn-valid patterns | `4111-1111-1111-1111` → `[CC]` |
| API Keys / Tokens | Common key patterns | `sk-proj-abc123...` → `[APIKEY]` |
| Passwords in Logs | `password=`, `passwd:` patterns | `password=hunter2` → `password=[REDACTED]` |
| Usernames | Context-aware extraction | `user 'admin'` → `user '[USER]'` |
| File Paths | Unix/Windows paths | `/home/jdoe/.ssh/id_rsa` → `[PATH]` |
| Hostnames | FQDN patterns | `prod-db-01.corp.internal` → `[HOST]` |

Each category is independently toggleable. Turn off what you don't need.

### Custom Regex Patterns

For domain-specific data, add your own regex patterns through the UI:

```
# Example: mask internal project codenames
Pattern: \b(PROJECT-(ALPHA|BRAVO|CHARLIE))\b
Replacement: [CODENAME]
```

### Field Stripping

Beyond message masking, you can strip entire fields before LLM submission. If your events include a `raw` JSON field with full request bodies, strip it entirely — the AI doesn't need it for security analysis.

### Live Test Filter

The most important feature: a **live test filter** in the Settings UI. Paste a real event, see exactly what the AI would receive. No guessing, no "I hope the regex works."

## What the AI Actually Sees

Before filtering:
```
Mar 5 10:15:32 prod-web-01 sshd[4521]: Failed password for admin from 203.0.113.42 port 52341 ssh2
```

After filtering:
```
Mar 5 10:15:32 [HOST] sshd[4521]: Failed password for [USER] from [IP] port 52341 ssh2
```

The AI can still detect the security event (failed SSH password attempt) but learns nothing about your specific infrastructure, usernames, or attacking IPs.

## The Self-Hosted Escape Hatch

Even with PII filtering, some organizations can't send any data externally. LogPulse AI works with any OpenAI-compatible API, including:

- **Ollama** — run models locally on your GPU
- **vLLM** — production-grade local inference
- **LM Studio** — desktop app for local models

Configure the endpoint URL in the GUI. No data ever leaves your network.

## Beyond Privacy: The Cost Benefit

PII filtering has an unintended positive side effect: **it reduces LLM token usage**. Stripping verbose file paths, long URLs, and embedded credentials from messages means fewer tokens per event. Less data in = less money out.

## Try It

LogPulse AI is open-source (MIT), self-hosted, and deploys in 5 minutes:

```bash
git clone https://github.com/PhilipLykov/LogPulseAI.git
cd LogPulseAI/docker
cp .env.example .env
docker compose --profile db up -d --build
```

Privacy controls are in **Settings > Privacy** after first login.

**GitHub:** [github.com/PhilipLykov/LogPulseAI](https://github.com/PhilipLykov/LogPulseAI)
**Landing page:** [philiplykov.github.io/LogPulseAI](https://philiplykov.github.io/LogPulseAI/)

If you're building or using AI-powered security tools, PII filtering before LLM submission shouldn't be optional. It should be the default.
