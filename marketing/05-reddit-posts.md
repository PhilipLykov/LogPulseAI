# Reddit Posts — Spaced 1-2 Days Apart

Post in this order. Wait 1-2 days between posts. Respond to every comment.

---

## Post 1: r/selfhosted (largest, most receptive audience)

**Title:**
```
I built an open-source AI-powered SIEM that filters PII before sending logs to the LLM — Docker deploy in 5 minutes
```

**Body:**

After getting frustrated with Wazuh's complexity and Graylog's paywalled features, I built my own self-hosted SIEM with AI-powered analysis.

**What it does:**
- Scores every log event across 6 security criteria using any OpenAI-compatible LLM (including Ollama for fully local)
- Maps threats to MITRE ATT&CK techniques
- Filters all PII (IPs, emails, credentials — 11 categories + custom regex) **before** anything reaches the LLM
- Produces structured findings with auto-deduplication and lifecycle management
- Full GUI configuration — no YAML editing, no SSH after initial Docker deploy

**The cost angle:** 16 optimization techniques (template dedup, score caching, severity filtering, batching) reduce LLM costs to $2-10/month with gpt-4o-mini for ~10k events/day. Or $0 with self-hosted Ollama.

**Stack:** Node.js, Fastify, React 19, PostgreSQL (time-partitioned), TypeScript. MIT licensed.

Quick start:
```
git clone https://github.com/PhilipLykov/LogPulseAI.git
cd LogPulseAI/docker && cp .env.example .env
docker compose --profile db up -d --build
```

Screenshots and docs: https://github.com/PhilipLykov/LogPulseAI

Would love feedback from this community. What features would make this useful for your homelab/infra?

---

## Post 2: r/homelab

**Title:**
```
My homelab SIEM setup: AI-powered log analysis with Docker, $2/month LLM costs, and no data sent to the cloud without PII filtering
```

**Body:**

I've been running my own AI SIEM for a few months now, monitoring Proxmox, Docker, Cisco switches, MikroTik, PostgreSQL, and a few other things. Wanted to share it since it might be useful for other homelabbers.

**LogPulse AI** collects logs from any source (Syslog, OpenTelemetry, Fluent Bit) and uses an LLM to score every event across 6 security criteria. It runs entirely in Docker — PostgreSQL, backend, and dashboard all in one compose.

What I like about it for homelab use:
- **Actually affordable** — $2-10/month with gpt-4o-mini, or $0 with Ollama running locally
- **5-minute setup** — `docker compose --profile db up -d --build` and you're done
- **Everything through the GUI** — configure AI models, add systems, set alerts, manage users, all from the browser
- **PII filtering** — strips IPs, emails, hostnames before sending to the LLM. If you're paranoid (like me), run Ollama and nothing leaves your network

Currently monitoring 8 systems and it catches things I'd miss in manual log review — like when my Proxmox node had an anomalous disk I/O pattern that the AI flagged before any error logs appeared.

GitHub: https://github.com/PhilipLykov/LogPulseAI (MIT, free)

Happy to answer questions about the setup or help with config.

---

## Post 3: r/cybersecurity

**Title:**
```
Open-source SIEM with 6-criteria AI scoring and MITRE ATT&CK mapping — privacy-first approach filters PII before LLM submission
```

**Body:**

I built an open-source SIEM focused on AI-powered analysis with a privacy-first design.

**The problem I was trying to solve:** Traditional SIEMs require manually writing detection rules. AI-powered alternatives send raw logs — including PII — to third-party APIs. I wanted something that does both: AI analysis AND data privacy.

**How LogPulse AI works:**

1. Events ingested via Syslog/OTel/pull connectors
2. PII filtering pipeline runs first — 11 categories (IPs, emails, credentials, etc.) + custom regex, all configurable through the GUI with a live test filter
3. AI scores each event template across 6 criteria: IT Security, Performance Degradation, Failure Prediction, Anomaly Detection, Compliance/Audit, Operational Risk
4. Meta-analysis aggregates scores into structured findings with MITRE ATT&CK technique IDs and confidence scoring
5. Findings have full lifecycle: auto-deduplication (TF-IDF + Jaccard), severity decay, auto-resolution

Works with any OpenAI-compatible API, including self-hosted models (Ollama, vLLM) for air-gapped environments.

RBAC with 20 granular permissions, immutable audit log (PostgreSQL trigger physically prevents modification), OWASP Top 10 compliant, bcrypt auth with enforced complexity.

MIT licensed, self-hosted: https://github.com/PhilipLykov/LogPulseAI

Interested in security professionals' perspective — is the 6-criteria scoring approach useful, or would you prefer a different taxonomy?

---

## Post 4: r/sysadmin

**Title:**
```
Built an open-source log analysis tool with AI that actually costs less than $10/month to run
```

**Body:**

I'm a sysadmin who got tired of scrolling through logs manually and couldn't justify Splunk pricing. Built an open-source tool that uses AI to analyze logs and surface issues automatically.

LogPulse AI connects to your existing log pipeline (Syslog, Fluent Bit, OpenTelemetry, or pull from Elasticsearch/Loki) and scores events across 6 criteria. It's caught things for me like:
- Anomalous disk I/O patterns before actual errors appeared
- SSH brute force attempts across multiple hosts
- A Docker container silently restarting due to OOM that was buried in info-level logs

**Practical details for sysadmins:**
- Docker deploy, no Kubernetes required
- Works with gpt-4o-mini ($2-10/mo) or self-hosted Ollama ($0)
- PII filtered before LLM — your IPs and hostnames stay private
- RBAC so you can give read-only access to junior staff
- Scheduled reports and alerting (Webhook, Telegram, Pushover, NTfy, Gotify)
- Everything configurable from the GUI

Not trying to replace Wazuh or Graylog for large enterprises. This is for small/mid teams who want AI-powered log analysis without the complexity or cost.

GitHub: https://github.com/PhilipLykov/LogPulseAI

---

## Post 5: r/opensource

**Title:**
```
LogPulse AI — open-source, AI-powered SIEM I've been building for the past year (MIT license, self-hosted)
```

**Body:**

I've been building an open-source SIEM platform and wanted to share it with this community.

**LogPulse AI** uses LLMs to continuously analyze log events and surface security threats, performance issues, and anomalies. It's self-hosted, Docker-deployed, and MIT licensed.

Key design decisions:
- **Privacy-first**: All PII is filtered before LLM submission (11 categories + custom regex). Works with self-hosted models for fully air-gapped setups.
- **Cost-conscious**: 16 optimization techniques keep LLM costs at $2-10/month. Template deduplication alone eliminates ~90% of redundant API calls.
- **GUI-first**: No YAML editing or SSH after initial Docker deploy. Every setting — AI models, prompts, alerts, users, privacy filters — is configurable from the browser.
- **Standards-based**: MITRE ATT&CK mapping, OWASP Top 10 compliant, RBAC with 20 permissions, immutable audit log.

Tech stack: TypeScript end-to-end (Node.js/Fastify + React 19), PostgreSQL with time-based partitioning.

I'm the sole developer. The project is genuinely non-commercial — no paid tier, no telemetry, no "enterprise edition." MIT license, the whole thing.

GitHub: https://github.com/PhilipLykov/LogPulseAI
Landing page: https://philiplykov.github.io/LogPulseAI/

Feedback, issues, and contributions welcome. What would make you try (or not try) a project like this?
