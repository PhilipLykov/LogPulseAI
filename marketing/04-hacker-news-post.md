# Hacker News — Show HN Post

## Submission Details

**URL to submit:** `https://news.ycombinator.com/submit`

**Title (max 80 chars):**
```
Show HN: LogPulse AI – Open-source SIEM with privacy-first AI log analysis
```

**URL:**
```
https://github.com/PhilipLykov/LogPulseAI
```

**Text (leave blank — link-only post performs better on Show HN):**

*(HN shows either URL or text, not both. Use URL to drive traffic to GitHub.)*

---

## First Comment (post immediately after submission)

Post this as the first comment to provide context:

---

Hi HN, I built this because every SIEM I tried was either too expensive (Splunk), took days to set up (Wazuh), or didn't have AI analysis built in.

LogPulse AI is a self-hosted, open-source SIEM that:

- Scores every log event across 6 criteria (IT Security, Performance, Failure Prediction, Anomaly Detection, Compliance, Operational Risk) using any OpenAI-compatible LLM
- Maps threats to MITRE ATT&CK techniques with confidence scoring
- Filters all PII (IPs, emails, credentials, etc.) **before** sending data to the LLM — 11 built-in categories plus custom regex
- Costs $2-10/month in LLM fees (gpt-4o-mini) thanks to 16 optimization techniques — template deduplication alone reduces calls by ~90%
- Deploys in 5 minutes with Docker
- Works with self-hosted models (Ollama, vLLM) for fully air-gapped setups

Tech stack: Node.js/Fastify backend, React 19 dashboard, PostgreSQL with time-based partitioning, TypeScript end-to-end.

The cost engineering was the hardest part. Naive per-event LLM analysis would cost $150+/month for a moderate server. I wrote a detailed breakdown of the 16 optimization layers in a dev.to post: [link to article-cost when published]

Happy to answer any questions about the architecture, the AI pipeline, or deployment.

---

## Timing

- **Best day:** Tuesday or Wednesday
- **Best time:** 8-9 AM US Pacific (4-5 PM UTC)
- **Be online for 4+ hours** to respond to every comment
- Don't ask friends to upvote — HN detects and penalizes this
