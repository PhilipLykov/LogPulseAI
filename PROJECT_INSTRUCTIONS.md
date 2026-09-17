# Project Instructions (User Requirements — In Order)

**Purpose:** Persist all user instructions so they survive context limits. **Anyone working on this project (including AI) must read this file at the start of work and follow it.**

---

## Instruction 1 (Project kickoff)

- New project in a new folder.
- Build a system to: **collect logs (syslog)**, **store** them, **search** within them, and **analyze with AI**.
- Start from a **market study** — check if such solutions already exist.
- Requirements: **free of charge** (except the AI part), preferably **open source**, **comparably lightweight**, run on **Docker** with **separated PostgreSQL** (already exists).
- If no suitable solution exists, build it **production-ready**.

---

## Instruction 2 (Database)

- **No need for PostgreSQL.** You are free to use **any DB** (no constraint on database choice).

---

## Instruction 3 (ELK)

- User asked why **ELK** was not in the market study. ELK was added to the study with the note that it was omitted from the main recommendation because the user asked for **"comparably lightweight"** — ELK is heavy (e.g. Elasticsearch &lt; 8 GB RAM is counterproductive).

---

## Instruction 4 (LogTide details)

- User requested **more information about LogTide and its possibilities.** An overview document was created: **LOGTIDE_OVERVIEW.md**.

---

## Instruction 5 (AI analysis and cost control — current)

- **All logs** that come into the system **must be considered by AI** from **exactly 6 criteria** (user provided 3; 3 more were added). Full list and definitions: **AI_ANALYSIS_SPEC.md**. Summary:
  1. **IT Security**
  2. **Performance Degradation**
  3. **Failure Prediction**
  4. **Anomaly / Unusual Patterns**
  5. **Compliance / Audit Relevance**
  6. **Operational Risk / Service Health**
- Events must be considered **not only one by one** but **all together** — to improve observability and **replace a person** in the analysis of logs.
- **Cost control for the LLM** is required:
  - **Deduplication of logs** before sending to the LLM.
  - **Preprocessing** of logs to make their processing by the LLM **cheaper** (e.g. summarization, batching, filtering, template extraction).
- **Persist instructions:** **Write on disk all user instructions in order** so they are available when the context window runs out. This file (**PROJECT_INSTRUCTIONS.md**) fulfills that.
- **Always reread:** When working on this project, **always reread** these instructions (this file).

---

## Instruction 6 (Per-event scores and meta-analyze)

- There must be a **separate score for every criterion for every event** (6 scores per event).
- In addition, **joint event revision** (meta-analyze) must produce **scores by every criterion with higher weight** — i.e. when looking at the situation “from the top” (all events together), the system outputs meta-scores for the same 6 criteria, and these meta-scores carry **higher weight** than per-event scores (e.g. for alerting or dashboards).
- The **mechanism** of joint event revision and the **scoring mechanism** (per-event vs meta, scale, how weight is applied) must be designed and documented. See **AI_ANALYSIS_SPEC.md** sections “Scoring mechanism” and “Joint event revision (meta-analyze)”.

---

## Instruction 7 (Blend weighting, system description, dashboard)

- **Option B (blend)** is chosen for combining meta- and per-event scores: `effective_score = w_meta * meta_score + (1 - w_meta) * max(per_event_scores)` with `w_meta` &gt; 0.5 (e.g. 0.7). Document and implement this as the standard.
- **Monitored system description:** The user must be able to describe **each monitored system** in **simple language** (free text). This description is **used by the AI/LLM** when (1) evaluating events (per-event scoring) and (2) during **meta-analysis**. It provides context (e.g. role of the system, criticality, dependencies) so the LLM can score more accurately.
- **Dashboard:** There must be a **dashboard** that shows the **scores in real time for every monitored system** (the 6 criteria, using the effective/blended score where applicable). Design and document the dashboard: what is a "system", how scores are shown, how real-time updates work. See **AI_ANALYSIS_SPEC.md** for the detailed design.

---

## Instruction 8 (Monitored system = group of log sources)

- A **monitored system** can **group several different log sources** (e.g. OS log, app error log, user activity journaling log). The application must be **designed accordingly**: model and ingest should support multiple log sources per system, and the LLM/dashboard should treat the system as the aggregation of all its sources. See **AI_ANALYSIS_SPEC.md** §5 (Log sources and monitored system) for the data model and app design.

---

## Instruction 9 (Market research: AI log analysis solutions)

- Perform **market research again** on **log analysis solutions with AI integration** for similar purposes (security, performance, failure prediction, anomaly, compliance, operational risk). Include **commercial** solutions.
- **Deliverables:** Find solutions, learn their features, and document **ideas to add to our app or change our approach**. See **MARKET_RESEARCH_AI_LOG_ANALYSIS.md**.

---

## Instruction 10 (All ideas, Pushover/Telegram, connect with other log systems)

- **Add all ideas** from the AI market research (MARKET_RESEARCH_AI_LOG_ANALYSIS.md) to the project as accepted features. Document them in a single place (see **FEATURES_AND_INTEGRATIONS.md**).
- **Integrations to add:**
  - **Pushover** (and similar push-notification services): send push notifications when scores exceed thresholds or on scheduled reports. Design so other push services (e.g. Gotify, NTfy, Bark) can be added the same way.
  - **Telegram:** send messages via Telegram Bot API (e.g. alerts and report summaries) with configurable bot token and chat ID.
- **Product design:** The solution is a **comprehensive AI log audit and analysis product** that must be **able to connect with other log collection and store systems** — not only the stack chosen for one installation. Support **connectors/adapters** so users can plug in different collectors and stores (e.g. Elasticsearch, Loki, LogTide, VictoriaLogs, Fluent Bit, Vector, syslog, S3, etc.). The product should work as an **AI analysis layer** on top of existing log infrastructure. See **FEATURES_AND_INTEGRATIONS.md** §2 (Connector architecture).

---

## Instruction 11 (OWASP Top 10 — secure by design)

- The solution must be **secure by design**. **OWASP Top 10** rules must always be followed in design and implementation.
- Security controls are built in from the design phase (architecture, APIs, connectors, dashboard, deployment), not added as an afterthought.
- See **SECURITY_OWASP.md** for the mapping of OWASP Top 10:2021 (and relevant 2025) to our product and the concrete requirements for each category.

---

## Instruction 12 (LLM provider quota recovery)

- If the AI provider balance is exhausted, analysis must **pause** and leave events **unscored**. It must **not** store failed LLM calls as zero scores or cache them as routine.
- After the operator refills the balance, analysis must **resume automatically** (cooldown then retry) without a manual restart. Settings must show the pause and offer **Resume now**.
- Quota HTTP 429 (`insufficient_quota`) is **not** a rate limit and must not be retried as if it were.

---

## Meta-rule for assistants

- **At the start of any work on this project:** Read **PROJECT_INSTRUCTIONS.md** and **AI_ANALYSIS_SPEC.md** to align with the user’s requirements, the 6 analysis criteria, and the cost-control measures (deduplication, preprocessing, cost observability).

---

*Last updated: 2026-09-17. Append new instructions below in order; do not remove or reorder existing ones.*
