# Directory Listings — Submission Guide

## 1. awesome-selfhosted (281k stars)

**URL:** https://github.com/awesome-selfhosted/awesome-selfhosted-data
**How:** Submit a PR creating `software/logpulse-ai.yml`
**Category:** Monitoring (or propose "Log Management" if sufficient projects exist)

**IMPORTANT: Cannot submit yet.** awesome-selfhosted requires the first release to be 4+ months old. First release (v0.7.0-beta) was Feb 10, 2026. **Earliest submission: June 10, 2026.**

Also: releases must NOT be pre-release-only. Consider publishing a stable `v1.0.0` release before submitting.

### Prepared YAML (save as `software/logpulse-ai.yml`)

```yaml
name: LogPulse AI
website_url: https://philiplykov.github.io/LogPulseAI/
source_code_url: https://github.com/PhilipLykov/LogPulseAI
description: AI-powered SIEM platform with 6-criteria LLM scoring, MITRE ATT&CK mapping, and privacy-first PII filtering (alternative to Wazuh, Graylog, Splunk)
licenses:
  - MIT
platforms:
  - Nodejs
  - Docker
tags:
  - Monitoring
```

Note: Description avoids "open-source", "free", "self-hosted" per their guidelines (those are implied by presence on the list).

---

## 2. awesome-sysadmin

**URL:** https://github.com/awesome-foss/awesome-sysadmin
**How:** Submit a PR adding to the "Log Management" section
**Format:** Markdown table row
**Timeline:** Check their contribution guidelines for maturity requirements

### Prepared entry

```markdown
- [LogPulse AI](https://github.com/PhilipLykov/LogPulseAI) - AI-powered SIEM with 6-criteria LLM scoring, MITRE ATT&CK mapping, and privacy-first PII filtering. `MIT` `Nodejs/Docker`
```

---

## 3. OSSAlternatives.to

**URL:** https://ossalternatives.to/
**How:** Submit via their "Submit" button or community contribution
**Position as alternative to:** Splunk, Graylog, Wazuh, ELK Stack

### Submission details

- **Name:** LogPulse AI
- **URL:** https://github.com/PhilipLykov/LogPulseAI
- **Category:** SIEM / Log Management / Security
- **Description:** AI-powered open-source SIEM that scores every log event across 6 security criteria using LLMs, maps threats to MITRE ATT&CK, and filters PII before LLM submission. Docker deploy in 5 minutes. MIT licensed.
- **Alternatives to:** Splunk, Graylog, Wazuh, ELK Stack

---

## 4. AlternativeTo.net

**URL:** https://alternativeto.net/
**How:** Click "Add Application" (requires free account)
**Position as alternative to:** Splunk, Graylog, Wazuh

### Submission details

- **Name:** LogPulse AI
- **Website:** https://philiplykov.github.io/LogPulseAI/
- **Description:** Open-source, self-hosted AI-powered SIEM platform. Uses LLMs to score log events across 6 security criteria (IT Security, Performance, Failure Prediction, Anomaly Detection, Compliance, Operational Risk) with MITRE ATT&CK mapping. Features privacy-first PII filtering before LLM submission, 16 cost optimization techniques ($2-10/month), 5-minute Docker deployment, and full GUI configuration.
- **License:** MIT (Open Source)
- **Platform:** Self-Hosted, Web, Docker
- **Tags:** SIEM, Log Analysis, AI, Security, Monitoring, Open Source

---

## 5. LibHunt.com

**URL:** https://libhunt.com/
**How:** Auto-indexed from GitHub when the repo gains enough visibility. Check if already listed at `https://www.libhunt.com/r/LogPulseAI`. If not, it should appear once stars increase.
**Action:** Verify listing periodically after gaining some stars.

---

## 6. AwesomeOpenSource.com

**URL:** https://awesomeopensource.com/
**How:** Auto-indexed from GitHub. Ensure proper topics are set on the repo (already done: 20 topics).
**Action:** Search for "LogPulse AI" to verify listing after a few days.

---

## 7. Additional Directories (Submit When Ready)

| Directory | URL | Notes |
|-----------|-----|-------|
| **Slant** | slant.co | "What are the best open-source SIEM tools?" answers |
| **StackShare** | stackshare.io | Add as a tool in the Monitoring/Security category |
| **OpenAlternative** | openalternative.co | Submit via their form |
| **SaaSHub** | saashub.com | Even for non-SaaS, they list self-hosted alternatives |
| **SourceForge** | sourceforge.net | Old but still gets traffic; mirror the project there |

---

## Submission Schedule

| When | What |
|------|------|
| **Now** | AlternativeTo, OSSAlternatives.to, awesome-sysadmin |
| **Week 2-3** | Verify LibHunt and AwesomeOpenSource auto-indexing |
| **June 2026** | awesome-selfhosted (after 4-month maturity) |
| **After v1.0** | Slant, StackShare, OpenAlternative, SaaSHub, SourceForge |
