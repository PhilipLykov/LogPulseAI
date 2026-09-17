# AI Log Analysis: Criteria, Correlation, and Cost Control

**Context:** See **PROJECT_INSTRUCTIONS.md** for the full list of user instructions. This document defines the AI analysis behavior and cost-control measures.

---

## 1. Analysis Criteria (max 6)

Every log (or log stream) that enters the system must be evaluated by the AI from **all** of the following aspects:

| # | Criterion | Description |
|---|-----------|--------------|
| 1 | **IT Security** | Threats, intrusions, abuse, suspicious commands, auth failures, policy violations, malware indicators. |
| 2 | **Performance Degradation** | Slowness, high latency, resource exhaustion (CPU, memory, disk I/O), queue buildup, timeouts. |
| 3 | **Failure Prediction** | Signs of imminent failure: repeated errors, degrading health, resource trends, dependency instability. |
| 4 | **Anomaly / Unusual Patterns** | Deviations from normal behavior: unexpected volume, new log types, unusual timing or sequence. |
| 5 | **Compliance / Audit Relevance** | Events that matter for audit or compliance: access changes, config changes, data access, retention. |
| 6 | **Operational Risk / Service Health** | Availability impact, risky actions (restarts, deploys), dependency failures, cascading or blast-radius risk. |

**Deliverable:** For each (batch or window of) logs, the system must produce a structured assessment (e.g. scores, flags, or short summaries) against these six criteria, so that a human is not required to manually scan and interpret raw logs.

---

## 2. Scoring Mechanism

### 2.1 Score scale and format

- **Scale:** Numeric score per criterion in a fixed range so that scores are comparable and aggregatable. Recommended: **0.0–1.0** (float) where:
  - `0` = no concern / not applicable
  - `0.25` = low
  - `0.5` = medium
  - `0.75` = high
  - `1.0` = critical / immediate attention
- **Per-event output:** Every event must receive **exactly 6 scores**, one per criterion. Example structure:
  ```json
  { "event_id": "...", "scores": { "it_security": 0.1, "performance_degradation": 0.0, "failure_prediction": 0.2, "anomaly": 0.0, "compliance_audit": 0.0, "operational_risk": 0.05 }, "reason_codes": ["..."] }
  ```
- Optional: short **reason codes** or one-line **explanation** per criterion when score &gt; 0 (for drill-down and audit).

### 2.2 Two levels of scores

| Level | Scope | Use |
|--------|--------|-----|
| **Per-event scores** | One score per criterion **per event** (6 scores per event). | Drill-down, per-line visibility, filtering, and as input to meta-analyze. |
| **Meta-scores** | One score per criterion **per window/group** (6 scores per meta-result). Produced by **joint event revision (meta-analyze)**. | **Higher weight:** when present, they represent the "view from the top" and override or outweigh per-event scores for alerting, dashboards, and prioritization. |

### 2.3 How "higher weight" for meta-scores is applied (Option B: blend)

- **Chosen method: Option B (blend).** The effective score for a criterion in a given context (e.g. time window + monitored system) is:
  - **Formula:** `effective_score = w_meta * meta_score + (1 - w_meta) * max(per_event_scores)` for that criterion in that scope.
  - **Constraint:** `w_meta` &gt; 0.5 so meta has higher weight (e.g. **default w_meta = 0.7**). Configurable per deployment.
  - **When only per-event scores exist** (e.g. before meta-analyze has run, or for a tiny window): `effective_score = max(per_event_scores)` (or 95th percentile) for that criterion in that scope.
- **Storage:** Store both per-event scores and meta-scores with clear labels (`score_type: "event"` vs `score_type: "meta"`) and reference to `window_id` / `group_id` / `system_id` so the blend can be computed consistently for alerting and the dashboard.

---

## 3. Joint Event Revision (Meta-Analyze)

**Definition:** Meta-analyze is the process of re-evaluating a **set of events together** (a window or a correlation group) so the AI can assess the **overall situation** for each of the 6 criteria and produce **meta-scores** that carry higher weight than individual event scores.

### 3.1 When meta-analyze runs

- **Trigger** (configurable):
  - **Time-based:** e.g. every N minutes over the last M minutes of events (sliding or tumbling window).
  - **Count-based:** after every K events (or K deduplicated templates) in a group.
  - **Group-based:** when a correlation group is "closed" (e.g. by `service` + `host`, or `trace_id`, or tenant).
- **Input to the LLM:** Preprocessed representation of **all** events in that window/group (after dedup and template extraction): e.g. list of templates + counts, time range, grouping keys, and optionally a few raw sample lines for critical or high-scoring events.

### 3.2 What the LLM receives and returns

- **Input:** Structured payload, e.g.:
  - `window_id`, `from`, `to`, optional `service` / `host` / `trace_id` (and thus **monitored system**)
  - **Monitored system description** (§4) for the system(s) in this window — simple-language context for the LLM
  - List of (template_id, message_template, count, first_seen, last_seen) or similar
  - Optional: per-event scores already computed (so the model can "see" what single-event analysis said and then revise from the top)
- **Prompt:** Ask the model to (1) consider the **whole set** as one situation, (2) output **6 meta-scores** (same scale 0.0–1.0), (3) optional **short summary** and **top findings** (e.g. "Repeated connection timeouts suggest impending failure of service X").
- **Output:** One meta-result per window/group, e.g.:
  ```json
  { "window_id": "...", "meta_scores": { "it_security": 0.2, "performance_degradation": 0.6, "failure_prediction": 0.7, "anomaly": 0.3, "compliance_audit": 0.0, "operational_risk": 0.5 }, "summary": "...", "findings": ["..."], "weight": "higher" }
  ```
  The `weight: "higher"` is a tag for the system: when combining or displaying scores, apply the rule in §2.3.

### 3.3 Pipeline placement

- **Order:** (1) Ingest → (2) Dedup + preprocess → (3) **Per-event scoring** (LLM or rule-based per event/template) → (4) **Meta-analyze** over windows/groups (LLM receives batch + optional per-event scores) → (5) Store event scores + meta-scores → (6) Alerting/dashboards use meta-scores with higher weight when available.

### 3.4 Summary

- **Per-event:** 6 scores per event; stored with `score_type: "event"`.
- **Meta-analyze:** Runs over windows/groups; produces 6 meta-scores + optional summary/findings; stored with `score_type: "meta"` and `window_id`/`group_id`.
- **Usage:** Meta-scores have **higher weight** (blend with w_meta, see §2.3) when the system decides "what is the score for criterion X in this context?" so that the "view from the top" replaces a person's first-pass analysis.

---

## 4. Monitored system description (context for the LLM)

Each **monitored system** (see §5 for definition; a system can **group multiple log sources**) can have a **free-text description in simple language**. This description is **used by the AI/LLM** to improve scoring accuracy.

### 4.1 Purpose

- Gives the LLM **context** about the system: e.g. role ("main API gateway"), criticality ("handles checkout"), dependencies ("talks to payment service"), or known quirks ("noisy debug logs after midnight"). The description can also mention which **log sources** are aggregated (e.g. "OS log, app error log, user activity journaling").
- Used in **both** (1) **per-event scoring** and (2) **meta-analysis** so that the same context is available when evaluating single events and when assessing the whole window.

### 4.2 Storage and usage

- **Storage:** One description per monitored system (e.g. in `monitored_systems`: `system_id`, `name`, `description` text). Editable by the user (UI or API). The list of **log sources** belonging to the system (§5.0) is stored separately and can be passed to the LLM along with the description (e.g. "This system aggregates: OS log, app error log, user activity journaling log").
- **Per-event scoring:** When sending an event (or template) to the LLM, include the **system description** and the **log source label** (e.g. "OS log") for the event. Example: "Monitored system context: [description]. Log source: [source label]. Evaluate the following event against the 6 criteria..."
- **Meta-analyze:** When sending a window/group to the LLM, include the **system description** and the **list of log source types** present in that window. Example: "Monitored system context: [description]. Sources in this window: OS log, app error log, user activity journaling. Consider the following set of events as one situation and output meta-scores..."
- **Optional:** If no description is set, the LLM still scores using only the log content; description is an optional enhancement.

---

## 5. Log sources and monitored system (app design)

The application must be designed so that a **monitored system** can **group multiple log sources** (e.g. OS log, app error log, user activity journaling log). Each log is assigned to one **log source**; each log source belongs to one **monitored system**. Scores are computed and displayed **per monitored system** (aggregating all its sources).

### 5.0 Data model: log sources and monitored systems

- **Log source:** A single type or stream of logs that can be identified by rules. Examples: "OS log" (syslog from the host), "app error log" (application stderr/error logs), "user activity journaling log" (audit/activity logs). Each log source has:
  - **id** (stable), **label** or **type** (human-readable, e.g. "OS log", "app error log", "user activity journaling")
  - **selector** (rule to match incoming logs to this source): e.g. syslog facility + program, file path, tag, `service`+`source_type`, or a custom expression. Stored as JSON or structured config.
  - **system_id** (FK): the monitored system this source belongs to.
- **Monitored system:** A logical grouping of **one or more log sources**. Has **id**, **name**, optional **description** (simple language, §4). Examples: "Production API" (groups: OS log, app error log, user activity log), "Checkout service" (groups: container log, app error log, DB connection log).
- **Relationship:** One monitored system → many log sources. Each log at ingest is matched to **exactly one** log source (first matching selector wins, or explicit routing); that gives a **system_id** and **log_source_id** for the event. Store both on the event (denormalized) for fast filtering and scoring.
- **Matching at ingest:** When a log arrives, evaluate **log source selectors** (e.g. by facility, program, path, tag) to assign `log_source_id` and thus `system_id`. If no selector matches, the event can go to a default "ungrouped" system or be dropped according to policy.
- **LLM and dashboard:** Per-event and meta-analyze use **system_id** as the grouping key. The LLM receives the system description plus the **list of log source labels** in the current window so it knows "this system aggregates OS log, app error log, user activity journaling" and can weight or interpret events accordingly.
- **Configuration (UI/API):** The app must allow users to (1) create and edit **monitored systems** (name, description), and (2) define **log sources** per system (label, selector). Selectors can be simple (e.g. `facility=auth`, `program=nginx`, `tag=os`) or structured (JSON rule). Order of evaluation or priority can determine which source matches when several could apply.

### 5.1 What is a "monitored system" (summary)

- **Definition:** A logical entity that **groups one or more log sources** (e.g. OS log, app error log, user activity journaling log). It has a name, optional simple-language description (§4), and a stable ID. Scores (per-event, meta, effective) are computed **per monitored system** by aggregating all events from all its sources.
- **Mapping:** Each log is matched to a **log source** via the source's selector; the log source belongs to one **monitored system**. Events store `system_id` and `log_source_id` for downstream scoring and the dashboard.

### 5.2 What the dashboard shows

- **Per system:** One row or card per monitored system. For each system, display **6 scores** (one per criterion): IT Security, Performance Degradation, Failure Prediction, Anomaly, Compliance/Audit, Operational Risk.
- **Score value:** Use the **effective score** (blend of meta + per-event per §2.3) for the **latest window** or **rolling short window** (e.g. last 5 minutes) so the dashboard reflects current state.
- **Visualization:** Each criterion can be shown as a **gauge**, **progress bar**, or **numeric indicator** (0.0–1.0 or 0–100). Use color bands (e.g. green / yellow / orange / red) by score range for quick scanning.
- **Optional:** System name, **list of log source labels** (e.g. "OS log, app error log, user activity") so users see what the system aggregates; last updated time; link to **drill-down** (list of events and meta-summary for that system in the selected time range). Drill-down can optionally filter or facet by log source.

### 5.3 Real-time updates

- **Mechanism:** Either (1) **Server-Sent Events (SSE)** pushing score updates when new per-event or meta results are stored, or (2) **short-interval polling** (e.g. every 10–30 s) for the current effective scores per system. SSE is preferred for true real-time feel.
- **Data source:** Backend computes effective scores per system per criterion (from stored event + meta scores and blend formula) and exposes an API (e.g. `GET /api/v1/scores/systems` or `/api/v1/scores/stream`) that the dashboard consumes.

### 5.4 Layout and UX

- **Overview:** Grid or list of system cards; each card shows the 6 scores at a glance. Sort or filter by system name or by highest score (e.g. "show systems with any criterion &gt; 0.7 first").
- **Time range:** Option to show scores for "last 5 min", "last 1 hour", etc. (affects which window is used for meta and thus effective score).
- **Drill-down:** Clicking a system (or a criterion) opens a detail view: events in the window, meta-summary and findings, and raw log samples so a human can validate or dig deeper.

---

## 6. Single-Event vs. Correlated Analysis

- **Single-event analysis:** Each log (or deduplicated representative) can be scored/annotated per criterion when useful (e.g. for real-time alerts).
- **Correlated analysis (required):** Logs must also be considered **all together** within a time window or context (e.g. by service, host, trace_id, or tenant). The AI should:
  - Detect patterns across multiple events (e.g. sequence of errors before outage).
  - Improve observability by summarizing “what’s going on” over a window, not only per line.
  - **Replace a person** in the first pass of log analysis: the output should be actionable summaries and findings, not raw log dumps.

So the pipeline must support both:
- **Per-event (or per-dedup-group) assessment** where appropriate.
- **Aggregate/correlated assessment** over streams or windows of logs.

---

## 7. Cost Control for the LLM

To keep LLM usage **predictable and low cost**, the system **must** implement:

### 7.1 Deduplication

- **Before** sending data to the LLM, reduce duplicate or near-duplicate logs:
  - **Exact duplicates:** Same message (and key fields) within a time window → send one representative + count.
  - **Near-duplicates / templates:** Logs that differ only by variables (e.g. IP, ID, timestamp) → represent as one template + sample instances + counts.
- Store or pass **counts** and **first/last occurrence** so the AI still knows volume and timing without seeing every duplicate line.

### 7.2 Preprocessing (to make LLM processing cheaper)

- **Log normalization:** Parse and extract common fields (timestamp, level, service, message, trace_id, etc.) so the model receives structured or semi-structured input where possible.
- **Template extraction:** Replace repeated messages with a single template + list of variables (e.g. “Connection from {ip} failed” → one template + N instances). Send templates and aggregates to the LLM, not every raw line.
- **Filtering / sampling:** Optionally exclude or sample low-value logs (e.g. debug at scale, or known-noisy sources) before LLM analysis, according to configurable policy.
- **Batching:** Send the LLM **batches** of preprocessed events (or templates + counts) per time window or per correlation group, with clear boundaries (e.g. “window 10:00–10:05, service X”) so the model can do correlated analysis in one call instead of many.
- **Summarization tiers (optional):** For very large windows, consider a two-phase approach: (1) cheap/small model or rules to produce a short summary or key events, (2) send only that summary (and critical raw samples) to the main LLM for the six-criteria assessment.

### 7.3 Observability of cost

- **Measures to implement:** Track and optionally cap:
  - Number of log lines (or events) sent to the LLM per hour/day.
  - Number of tokens (or API calls) per hour/day.
  - Configurable limits or alerts when thresholds are exceeded.

### 7.4 Provider quota and billing failures

- A billing/quota error from the LLM provider is **not** a successful analysis. Events must remain **unscored** so they can be analysed after the balance is restored.
- Do **not** write all-zero scores or cache them as “routine”. That permanently hides the window from later analysis.
- Pause further LLM calls with a cooldown, then retry automatically. Surface the pause in the operator UI.

---

## 8. Integration with the Rest of the System

- **Input:** All logs that “come to the system” (after ingestion, and optionally after storage) must be eligible for this AI analysis path.
- **Output:** Results (per-criterion assessments, correlated summaries, alerts) must be storable and queryable (e.g. in the same log platform or a dedicated store) so they can replace manual analysis and feed dashboards or notifications.
- **Placement:** The AI analysis can be a **post-ingestion pipeline** (e.g. consume from the log store or a queue), with deduplication and preprocessing **before** the LLM step.

---

## 9. References

- **User instructions (in order):** **PROJECT_INSTRUCTIONS.md**
- **Log platform context:** **README.md**, **MARKET_STUDY.md**, **LOGTIDE_OVERVIEW.md**

**Rule:** When implementing or designing this feature, reread **PROJECT_INSTRUCTIONS.md** and this spec to stay aligned with the user’s requirements.
