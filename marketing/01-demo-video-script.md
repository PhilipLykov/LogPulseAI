# Demo Video Script — LogPulse AI

**Target length:** 2-3 minutes
**Format:** Screen recording with voiceover (use OBS Studio — free)
**Resolution:** 1920x1080, upload to YouTube

---

## Scene 1: Hook (0:00 - 0:15)

**Screen:** Terminal, blank
**Voiceover:**

> "What if your logs could tell you what's wrong — before you even look at them?
> LogPulse AI is a free, open-source SIEM that uses AI to score every log event
> across six security criteria. Let me show you how to set it up in under five minutes."

---

## Scene 2: Install (0:15 - 0:45)

**Screen:** Terminal
**Actions:** Type these commands live (or pre-record and speed up slightly):

```bash
git clone https://github.com/PhilipLykov/LogPulseAI.git
cd LogPulseAI/docker
cp .env.example .env
# (show editing .env briefly — set DB_PASSWORD and DB_HOST=postgres)
docker compose --profile db up -d --build
```

**Voiceover:**

> "Clone the repo, set one password in the env file, and docker compose up.
> That's it. PostgreSQL, the backend, and the dashboard all start automatically."

**Show:** `docker compose exec backend sh -lc "cat /app/bootstrap-secrets.txt"` to get credentials.

---

## Scene 3: First Login & AI Config (0:45 - 1:15)

**Screen:** Browser at localhost:8070
**Actions:**
1. Log in with bootstrap credentials
2. Change password on first login
3. Navigate to Settings > AI Model
4. Enter an OpenAI API key (blur the actual key)
5. Select gpt-4o-mini

**Voiceover:**

> "First login, change your password, then head to Settings to configure your LLM.
> LogPulse works with any OpenAI-compatible API — including self-hosted models like Ollama.
> I'll use gpt-4o-mini which costs about two to ten dollars a month."

---

## Scene 4: Events Arriving (1:15 - 1:40)

**Screen:** Dashboard view showing systems with events arriving
**Actions:**
1. Show the Dashboard with score bars populating
2. Click into Event Explorer, show events being ingested
3. Show a filter (e.g., severity=error)

**Voiceover:**

> "Once events start flowing in — via Syslog, OpenTelemetry, or any of the pull connectors —
> the AI pipeline kicks in automatically. Every event gets scored across six criteria:
> IT Security, Performance, Failure Prediction, Anomaly Detection, Compliance, and Operational Risk."

---

## Scene 5: AI Findings (1:40 - 2:10)

**Screen:** AI Findings panel
**Actions:**
1. Show a finding with severity and description
2. Click "Show Events" to see source events
3. Show the MITRE ATT&CK technique tag if present
4. Acknowledge a finding with one click

**Voiceover:**

> "The AI doesn't just score — it produces structured findings with full lifecycle management.
> Automatic deduplication, severity decay, and auto-resolution.
> Each finding links back to the exact events that triggered it."

---

## Scene 6: Privacy Controls (2:10 - 2:30)

**Screen:** Settings > Privacy
**Actions:**
1. Show the PII masking categories (IPs, emails, etc.)
2. Show the live test filter with a sample event

**Voiceover:**

> "And here's what makes LogPulse different: all personal data is filtered *before*
> it ever reaches the LLM. IP addresses, emails, credentials — eleven categories
> plus your own custom patterns. You can verify it with the live test filter."

---

## Scene 7: Call to Action (2:30 - 2:50)

**Screen:** GitHub repo page / landing page
**Voiceover:**

> "LogPulse AI is fully open-source under the MIT license. Free forever.
> Star it on GitHub if this is useful, and check the docs to get started.
> Link in the description."

**Screen text overlay:** `github.com/PhilipLykov/LogPulseAI`

---

## Tips for Recording

- Use OBS Studio (free) for screen capture + mic
- Record at 1080p, 30fps
- Keep mouse movements slow and deliberate
- Speed up the docker build step (nobody wants to watch compilation)
- Add subtle background music (YouTube Audio Library has free tracks)
- YouTube title: "LogPulse AI — Open-Source AI SIEM in 5 Minutes (Free, Self-Hosted)"
- YouTube tags: open source siem, ai log analysis, self-hosted siem, mitre attack, docker siem, free siem, llm security
