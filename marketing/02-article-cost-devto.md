---
title: How I Built an AI-Powered SIEM That Costs $2/Month to Run
published: false
description: 16 optimization techniques that reduce LLM costs by 80-95% while scoring every log event across 6 security criteria
tags: opensource, security, ai, selfhosted
cover_image: https://raw.githubusercontent.com/PhilipLykov/LogPulseAI/master/docs/screenshots/dashboard.png
---

Every SIEM I evaluated was either prohibitively expensive (Splunk), required weeks of setup (Wazuh), or didn't have AI built in (Graylog, ELK). So I built my own.

**LogPulse AI** is an open-source, self-hosted SIEM that uses LLMs to score every log event across six security criteria and produce structured findings — with MITRE ATT&CK mapping. It runs on Docker and costs $2-10/month in LLM API fees.

This post focuses on the cost engineering: how I got there.

## The Problem: LLMs Are Expensive at Log Scale

A moderately busy server generates 10,000+ log events per day. Sending each one individually to GPT-4o-mini would mean 10,000 API calls per day. At ~500 tokens per call, that's 5 million tokens/day, or roughly **$150/month** just for per-event scoring. Add meta-analysis on top and you're looking at $200+.

That's not viable for an open-source tool.

## The Solution: 16 Layers of Optimization

I implemented 16 independent techniques that stack together. Here's how each one works and how much it saves.

### 1. Template Deduplication (saves ~90% of calls)

This is the single biggest win. Most log streams are repetitive:

```
Mar 5 10:01:15 web-01 nginx: 192.168.1.100 GET /api/health 200
Mar 5 10:01:16 web-01 nginx: 192.168.1.101 GET /api/health 200
Mar 5 10:01:17 web-01 nginx: 10.0.0.5 GET /api/health 200
```

These are three events, but they're the **same template**: `{IP} GET /api/health 200`. Instead of scoring each one, the system extracts the template, scores it once, and applies the result to all matching events.

On a typical server with repetitive health checks, cron output, and status messages, template deduplication reduces 10,000 events to ~200-500 unique templates.

### 2. Score Caching (saves ~70% of remaining calls)

Templates that were scored in the last 6 hours (configurable) reuse their cached result. If `nginx: GET /api/health 200` was scored at 0 two hours ago, it doesn't get sent to the LLM again.

Combined with template dedup, this means only **new, unique** message patterns trigger LLM calls.

### 3. Normal Behavior Filtering (variable, up to 100%)

Users can mark templates as "normal behavior" from the UI. These templates are permanently scored at 0 without any LLM call. This is how you teach the system: "yes, I know my cron job runs every 5 minutes, stop flagging it."

### 4. Severity Pre-Filter

Events at specified severity levels (e.g., `debug`, `info`) can be auto-scored at 0. For noisy systems that log thousands of debug-level messages, this eliminates them instantly.

### 5. Low-Score Auto-Skip

Templates that have been consistently scored near-zero across multiple pipeline runs are automatically promoted to zero-score status. The LLM "teaches" the system what is noise, and the system stops asking.

### 6. Message Truncation (saves ~30% tokens)

Event messages are truncated to 512 characters before LLM submission. The diagnostic value is almost always in the first few hundred characters. Long stack traces and JSON payloads waste tokens without adding detection value.

### 7. Batch Sizing (saves ~40% overhead)

20 templates are grouped into a single API call. The system prompt is sent once per batch instead of once per event. This alone nearly halves the per-template token cost.

### 8-11. Meta-Analysis Optimizations

The meta-analysis (which aggregates per-event scores into findings) has its own optimizations:

- **Zero-Score Window Skip**: When every event scored 0, the meta-analysis LLM call is skipped entirely
- **Zero-Score Event Filter**: Events that scored 0 are excluded from the meta prompt
- **High-Score Prioritization**: Events sorted by score ensure the most important ones fit within the cap
- **Event Cap**: Hard limit (default 200) prevents token explosion on very active systems

### 12. Per-Task Model Selection

Use gpt-4o-mini ($0.15/1M input) for per-event scoring and gpt-4o ($2.50/1M input) only for meta-analysis summaries. The cheap model handles volume; the capable model handles synthesis.

### 13-16. Pipeline & Infrastructure

- **Adaptive scheduling**: Pipeline runs every 15 min when busy, backs off to 2 hours when idle
- **Configurable chunk sizes**: Process events in chunks of 5,000 with a 10-minute time guard
- **Privacy filtering**: Stripping PII fields also reduces token count
- **Context window control**: Limit how many previous analysis summaries are included as context

## The Result

With all optimizations enabled (most are on by default):

| Model | ~10,000 events/day | Monthly Cost |
|-------|-------------------|-------------|
| gpt-4o-mini | ~100-300 unique templates actually scored | **$2-10** |
| gpt-4o | same | $15-60 |
| Self-hosted (Ollama) | same | $0 |

The system tracks every LLM call with per-request metrics (model, tokens, cost) and per-system breakdowns, so you always know exactly what you're spending.

## The Full Picture

Cost optimization is just one part. LogPulse AI also includes:

- **6-criteria AI scoring** with tunable prompts per criterion
- **MITRE ATT&CK mapping** on findings
- **Privacy-first PII filtering** — 11 categories filtered *before* LLM submission
- **RBAC** with 20 granular permissions and immutable audit log
- **Real-time dashboard** with SSE-based refresh
- **RAG "Ask AI"** for natural language queries over event history
- **5-minute Docker deployment** with full GUI configuration

## Try It

```bash
git clone https://github.com/PhilipLykov/LogPulseAI.git
cd LogPulseAI/docker
cp .env.example .env
# Set DB_PASSWORD and DB_HOST=postgres in .env
docker compose --profile db up -d --build
```

Open `http://localhost:8070`, configure your LLM API key in Settings, and you're running.

**GitHub:** [github.com/PhilipLykov/LogPulseAI](https://github.com/PhilipLykov/LogPulseAI)
**Landing page:** [philiplykov.github.io/LogPulseAI](https://philiplykov.github.io/LogPulseAI/)

MIT licensed. Free forever. Stars and feedback welcome.
