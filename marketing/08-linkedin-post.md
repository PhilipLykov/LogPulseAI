# LinkedIn Post (Updated for LogPulse AI)

---

**I built an open-source AI-powered SIEM platform — and I'm sharing it with the community.**

After months of development, I'm excited to introduce **LogPulse AI** — a self-hosted log intelligence platform that brings enterprise-grade security monitoring to teams of any size, using LLM-based analysis to turn raw log streams into actionable insights.

**What it does:**
- Collects logs from any source (Syslog, OpenTelemetry, Elasticsearch, Fluent Bit, and more)
- Scores every event across 6 criteria: IT Security, Performance Degradation, Failure Prediction, Anomaly Detection, Compliance/Audit, and Operational Risk
- Maps threats to MITRE ATT&CK techniques with confidence scoring
- Produces structured findings with automatic deduplication, severity decay, and auto-resolution
- Includes a RAG-based "Ask AI" feature — query your entire log history in natural language

**Privacy-first AI — your data stays yours:**
One of the biggest concerns with AI-powered log analysis is sensitive data leaving your perimeter. LogPulse AI addresses this head-on with a configurable PII filtering pipeline that runs **before** any data is sent to an LLM. It supports 11 built-in masking categories (IP addresses, emails, phone numbers, URLs, MAC addresses, credit card numbers, passwords, API keys, usernames, and more), custom regex patterns for domain-specific data, and full field stripping — so you can surgically control what the AI sees. A live test filter lets you verify your rules against real events before enabling them. And if even that isn't enough, the platform works with fully self-hosted models (Ollama, vLLM, LM Studio), keeping everything on-premise.

**Enterprise-grade from day one:**
- **RBAC** with 3 roles and 20 granular permissions — Administrators, Auditors (read-only), and Monitoring Agents each see only what they need
- **Immutable audit log** with a PostgreSQL trigger that physically prevents modification or deletion — every administrative action is recorded with actor, IP, and full details, exportable as CSV/JSON for compliance
- **Session security** with SHA-256 hashed tokens, configurable expiry, account lockout, and enforced password complexity (12+ chars, mixed case, digits, special characters)
- **API key management** with scope-based permissions, IP allowlists, and expiration dates
- **OWASP Top 10 compliant** — parameterized queries, secure headers, rate limiting, non-root Docker containers, SSRF prevention, and more
- **Compliance export** — one-click export of events, scores, and findings in CSV or JSON for regulatory reporting

**Cost-efficient AI at scale:**
16 built-in optimization techniques (template deduplication, score caching, severity pre-filtering, batching, and more) reduce LLM costs by 80-95%. Typical cost with gpt-4o-mini: $2-10/month for ~10,000 events/day across 5 systems. Works with any OpenAI-compatible API — swap models from the UI without redeployment.

**Tech stack:** Node.js, Fastify, React 19, PostgreSQL (time-partitioned), TypeScript end-to-end. MIT licensed. Docker deployment in under 5 minutes.

If you're running infrastructure and want AI-powered log analysis without compromising on security, privacy, or compliance — give it a try. Feedback, stars, and contributions are welcome.

GitHub: https://github.com/PhilipLykov/LogPulseAI

#OpenSource #Cybersecurity #SIEM #ArtificialIntelligence #DevOps #LogManagement #InfoSec #SelfHosted #DataPrivacy #Compliance
