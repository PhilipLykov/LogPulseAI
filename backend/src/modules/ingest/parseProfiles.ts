import type { NormalizedEvent } from '../../types/index.js';

export type ParseProfileCategory =
  | 'database'
  | 'webserver'
  | 'network'
  | 'system'
  | 'security'
  | 'messaging'
  | 'general';

export type ParseProfileMultilineMode = 'none' | 'indent_only' | 'timestamp_head';

type MatchMode = 'first' | 'all';

interface ParseProfileExtractRule {
  fields: string[];
  pattern: RegExp;
  onMatch?: MatchMode;
}

export interface ParseProfile {
  id: string;
  label: string;
  description: string;
  category: ParseProfileCategory;
  multiline: {
    mode: ParseProfileMultilineMode;
    startPattern?: string;
    maxLines?: number;
  };
  extractFields?: ParseProfileExtractRule[];
  severityOverrides?: Record<string, string>;
  under_the_hood?: string[];
  result_changes?: string[];
}

export interface ParseProfileSummary {
  id: string;
  label: string;
  description: string;
  category: ParseProfileCategory;
  multiline_mode: ParseProfileMultilineMode;
  multiline_start_pattern?: string;
  extracted_fields: string[];
  under_the_hood: string[];
  result_changes: string[];
}

const SEVERITY_CANONICAL: Record<string, string> = {
  emerg: 'emergency',
  emergency: 'emergency',
  alert: 'alert',
  crit: 'critical',
  critical: 'critical',
  fatal: 'critical',
  panic: 'emergency',
  err: 'error',
  error: 'error',
  warning: 'warning',
  warn: 'warning',
  notice: 'notice',
  info: 'info',
  informational: 'info',
  debug: 'debug',
  trace: 'debug',
};

const CISCO_SEVERITY_MAP: Record<string, string> = {
  '0': 'emergency',
  '1': 'alert',
  '2': 'critical',
  '3': 'error',
  '4': 'warning',
  '5': 'notice',
  '6': 'info',
  '7': 'debug',
};

const PROFILE_REGISTRY: ParseProfile[] = [
  {
    id: 'docker',
    label: 'Docker / Container Apps',
    description: 'Safe parsing for container logs with key-value enrichment and no extra backend joins.',
    category: 'system',
    multiline: { mode: 'none' },
    extractFields: [
      { fields: ['docker_level'], pattern: /\b(?:level|lvl|severity)=(?<docker_level>[A-Za-z0-9_-]+)\b/i },
      { fields: ['docker_component'], pattern: /\b(?:component|module|service)=(?<docker_component>[A-Za-z0-9_.-]+)\b/i },
      { fields: ['docker_request_id'], pattern: /\b(?:request_id|req_id|trace_id)=(?<docker_request_id>[A-Za-z0-9-]+)\b/i },
      { fields: ['docker_error_code'], pattern: /\b(?:err(?:or)?_code|code)=(?<docker_error_code>[A-Za-z0-9_.-]+)\b/i },
    ],
    severityOverrides: {
      fatal: 'critical',
      panic: 'emergency',
      warn: 'warning',
      info: 'info',
      debug: 'debug',
      trace: 'debug',
    },
    under_the_hood: [
      'Disables backend multiline merging for this source to avoid accidental joins.',
      'Extracts common key=value fields (level/component/request_id/error_code) into event raw metadata.',
      'Normalizes severity aliases (fatal/panic/warn/trace) to canonical levels.',
    ],
    result_changes: [
      'Fewer false merged/split events for container workloads.',
      'Cleaner filtering/search in Event Explorer using extracted metadata fields.',
    ],
  },
  {
    id: 'postgresql',
    label: 'PostgreSQL',
    description: 'Structured extraction for PostgreSQL log level blocks and SQL context.',
    category: 'database',
    multiline: { mode: 'none' }, // Existing Methods 1/2 handle PG multiline.
    extractFields: [
      { fields: ['pg_sqlstate'], pattern: /\bSQLSTATE(?:\s+|\[)(?<pg_sqlstate>[A-Z0-9]{5})\]?/i },
      { fields: ['pg_detail'], pattern: /\bDETAIL:\s*(?<pg_detail>.+)$/im },
      { fields: ['pg_hint'], pattern: /\bHINT:\s*(?<pg_hint>.+)$/im },
      { fields: ['pg_context'], pattern: /\bCONTEXT:\s*(?<pg_context>.+)$/im },
      { fields: ['pg_statement'], pattern: /\bSTATEMENT:\s*(?<pg_statement>[\s\S]+)$/im },
    ],
  },
  {
    id: 'mysql',
    label: 'MySQL / MariaDB',
    description: 'Extracts MySQL/MariaDB error code, component, and statement context.',
    category: 'database',
    multiline: { mode: 'timestamp_head', startPattern: '^\\d{4}-\\d{2}-\\d{2}[T ]' },
    extractFields: [
      { fields: ['mysql_level'], pattern: /\[(?<mysql_level>ERROR|Warning|Note)\]/i },
      { fields: ['mysql_code'], pattern: /\[(?<mysql_code>MY-\d+)\]/i },
      { fields: ['mysql_component'], pattern: /\[(?<mysql_component>Server|InnoDB|Replication|X Plugin|Client)\]/i },
      { fields: ['mysql_statement'], pattern: /\b(?:Query|Statement)\s*:\s*(?<mysql_statement>.+)$/im },
    ],
    severityOverrides: {
      note: 'info',
      warning: 'warning',
      error: 'error',
    },
  },
  {
    id: 'apache_access',
    label: 'Apache httpd Access',
    description: 'Parses Apache access log HTTP fields (method, path, status, bytes, referrer).',
    category: 'webserver',
    multiline: { mode: 'none' },
    extractFields: [
      {
        fields: ['http_method', 'http_path', 'http_status', 'http_bytes', 'http_referer', 'http_user_agent'],
        pattern:
          /"(?<http_method>GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(?<http_path>\S+)\s+HTTP\/[0-9.]+"\s+(?<http_status>\d{3})\s+(?<http_bytes>\d+|-)\s+"(?<http_referer>[^"]*)"\s+"(?<http_user_agent>[^"]*)"/i,
      },
    ],
  },
  {
    id: 'apache_error',
    label: 'Apache httpd Error',
    description: 'Parses Apache error log fields (module, level, pid, client, and message).',
    category: 'webserver',
    multiline: { mode: 'timestamp_head', startPattern: '^\\[[A-Z][a-z]{2}\\s+[A-Z][a-z]{2}\\s+\\d{1,2}\\s+' },
    extractFields: [
      {
        fields: ['apache_time', 'apache_module', 'apache_level', 'apache_pid', 'apache_client', 'apache_message'],
        pattern:
          /^\[(?<apache_time>[^\]]+)\]\s+\[(?<apache_module>[^:\]]+):(?<apache_level>[^\]]+)\](?:\s+\[pid\s+(?<apache_pid>\d+)\])?(?:\s+\[client\s+(?<apache_client>[^\]]+)\])?\s+(?<apache_message>.+)$/im,
      },
    ],
    severityOverrides: {
      error: 'error',
      crit: 'critical',
      alert: 'alert',
      emerg: 'emergency',
      warn: 'warning',
      notice: 'notice',
      info: 'info',
      debug: 'debug',
    },
  },
  {
    id: 'nginx_access',
    label: 'nginx Access',
    description: 'Parses nginx access entries including request, status, bytes, and user-agent.',
    category: 'webserver',
    multiline: { mode: 'none' },
    extractFields: [
      {
        fields: ['http_method', 'http_path', 'http_status', 'http_bytes', 'http_referer', 'http_user_agent'],
        pattern:
          /"(?<http_method>GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(?<http_path>\S+)\s+HTTP\/[0-9.]+"\s+(?<http_status>\d{3})\s+(?<http_bytes>\d+)\s+"(?<http_referer>[^"]*)"\s+"(?<http_user_agent>[^"]*)"/i,
      },
      { fields: ['nginx_upstream_time'], pattern: /\bupstream_response_time[:=]\s*(?<nginx_upstream_time>[\d.,-]+)/i },
    ],
  },
  {
    id: 'nginx_error',
    label: 'nginx Error',
    description: 'Parses nginx error entries and extracts client/upstream context.',
    category: 'webserver',
    multiline: { mode: 'timestamp_head', startPattern: '^\\d{4}/\\d{2}/\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}' },
    extractFields: [
      {
        fields: ['nginx_level', 'nginx_request_id', 'nginx_error_message', 'nginx_client', 'nginx_server', 'nginx_request', 'nginx_upstream'],
        pattern:
          /\[(?<nginx_level>[a-z]+)\]\s+\d+#\d+:\s+\*(?<nginx_request_id>\d+)\s+(?<nginx_error_message>[^,]+)(?:,\s+client:\s+(?<nginx_client>[^,]+))?(?:,\s+server:\s+(?<nginx_server>[^,]+))?(?:,\s+request:\s+"(?<nginx_request>[^"]+)")?(?:,\s+upstream:\s+"(?<nginx_upstream>[^"]+)")?/i,
      },
    ],
    severityOverrides: {
      error: 'error',
      crit: 'critical',
      alert: 'alert',
      emerg: 'emergency',
      warn: 'warning',
      notice: 'notice',
      info: 'info',
      debug: 'debug',
    },
  },
  {
    id: 'cisco_ios',
    label: 'Cisco IOS / IOS-XE',
    description: 'Extracts Cisco facility/severity/mnemonic triples from %FAC-SEV-MNEM format.',
    category: 'network',
    multiline: { mode: 'none' },
    extractFields: [
      {
        fields: ['cisco_facility', 'cisco_severity', 'cisco_mnemonic', 'cisco_message'],
        pattern:
          /%(?<cisco_facility>[A-Z0-9_]+)-(?<cisco_severity>[0-7])-(?<cisco_mnemonic>[A-Z0-9_]+):\s*(?<cisco_message>.+)$/i,
      },
    ],
    severityOverrides: CISCO_SEVERITY_MAP,
  },
  {
    id: 'mikrotik',
    label: 'MikroTik RouterOS',
    description: 'Extracts MikroTik topic prefixes and message payload.',
    category: 'network',
    multiline: { mode: 'none' },
    extractFields: [
      { fields: ['mikrotik_topics', 'mikrotik_message'], pattern: /^(?<mikrotik_topics>[a-z0-9_,.-]+):\s*(?<mikrotik_message>.+)$/i },
    ],
  },
  {
    id: 'procurve',
    label: 'HP ProCurve / Aruba',
    description: 'Extracts level/module/message fields from ProCurve/Aruba syslog patterns.',
    category: 'network',
    multiline: { mode: 'none' },
    extractFields: [
      {
        fields: ['procurve_level', 'procurve_module', 'procurve_message'],
        pattern:
          /^(?<procurve_level>[IWEAF])\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{2}:\d{2}:\d{2}\s+(?<procurve_module>[A-Za-z0-9_.-]+):\s*(?<procurve_message>.+)$/i,
      },
    ],
    severityOverrides: {
      i: 'info',
      w: 'warning',
      e: 'error',
      a: 'alert',
      f: 'critical',
    },
  },
  {
    id: 'asterisk',
    label: 'Asterisk PBX',
    description: 'Handles Asterisk stack-style continuations and extracts channel/context details.',
    category: 'messaging',
    multiline: { mode: 'indent_only' },
    extractFields: [
      {
        fields: ['asterisk_time', 'asterisk_level', 'asterisk_pid', 'asterisk_file', 'asterisk_line', 'asterisk_message'],
        pattern:
          /^\[(?<asterisk_time>[^\]]+)\]\s+(?<asterisk_level>[A-Z]+)\[(?<asterisk_pid>\d+)\](?:\[[^\]]+\])?:\s+(?<asterisk_file>[^:]+):(?<asterisk_line>\d+)\s+(?<asterisk_message>.+)$/im,
      },
      {
        fields: ['asterisk_channel', 'asterisk_context', 'asterisk_extension'],
        pattern:
          /\bChannel\s+(?<asterisk_channel>[^,\s]+).*?\bContext\s+(?<asterisk_context>[^,\s]+).*?\bExtension\s+(?<asterisk_extension>[^,\s]+)/i,
      },
    ],
    severityOverrides: {
      error: 'error',
      warning: 'warning',
      notice: 'notice',
      verbose: 'info',
      debug: 'debug',
    },
  },
  {
    id: 'systemd',
    label: 'Debian / systemd',
    description: 'Extracts systemd unit, PID, and message fields.',
    category: 'system',
    multiline: { mode: 'none' },
    extractFields: [
      { fields: ['systemd_unit', 'systemd_pid', 'systemd_message'], pattern: /(?<systemd_unit>[A-Za-z0-9_.@-]+)\[(?<systemd_pid>\d+)\]:\s*(?<systemd_message>.+)$/i },
      { fields: ['systemd_unit', 'systemd_message'], pattern: /(?<systemd_unit>[A-Za-z0-9_.@-]+):\s*(?<systemd_message>.+)$/i },
    ],
  },
  {
    id: 'proxmox',
    label: 'Proxmox VE',
    description: 'Extracts Proxmox task context (VMID/UPID/subsystem/node) with conservative joining.',
    category: 'system',
    multiline: { mode: 'none' },
    extractFields: [
      { fields: ['proxmox_subsystem'], pattern: /\b(?<proxmox_subsystem>pveproxy|pvedaemon|pvescheduler|pvestatd|pve-firewall|pve-ha-lrm|pve-ha-crm|corosync)\b/i },
      { fields: ['proxmox_vmid'], pattern: /\b(?:vmid|VMID|VM)\s*[:=#]?\s*(?<proxmox_vmid>\d{2,6})\b/i },
      { fields: ['proxmox_upid'], pattern: /\b(?<proxmox_upid>UPID:[A-Za-z0-9:-]+)\b/i },
      { fields: ['proxmox_node'], pattern: /\bnode\s+(?<proxmox_node>[A-Za-z0-9_.-]+)\b/i },
    ],
    under_the_hood: [
      'Disables backend generic multiline joining for Proxmox source lines.',
      'Parses Proxmox-specific tokens (subsystem, VMID, UPID, node) from message text.',
      'Adds parsed values into event raw metadata for downstream filtering.',
    ],
    result_changes: [
      'Operational incidents in Proxmox become easier to correlate by VMID/UPID.',
      'Lower risk of unrelated lines being merged in high-volume cluster logging.',
    ],
  },
  {
    id: 'openssh',
    label: 'OpenSSH (sshd)',
    description: 'Extracts auth method, user, source IP, and source port from sshd messages.',
    category: 'security',
    multiline: { mode: 'none' },
    extractFields: [
      {
        fields: ['auth_method', 'auth_user', 'auth_source_ip', 'auth_port'],
        pattern:
          /Accepted\s+(?<auth_method>[a-z0-9-]+)\s+for\s+(?<auth_user>\S+)\s+from\s+(?<auth_source_ip>[0-9a-fA-F:.]+)\s+port\s+(?<auth_port>\d+)/i,
      },
      {
        fields: ['auth_method', 'auth_user', 'auth_source_ip', 'auth_port'],
        pattern:
          /Failed\s+(?<auth_method>[a-z0-9-]+)\s+for(?:\s+invalid user)?\s+(?<auth_user>\S+)\s+from\s+(?<auth_source_ip>[0-9a-fA-F:.]+)\s+port\s+(?<auth_port>\d+)/i,
      },
    ],
    severityOverrides: {
      authpriv: 'notice',
    },
  },
  {
    id: 'iptables',
    label: 'iptables / nftables',
    description: 'Extracts chain, action, source/destination IP, protocol, and destination port.',
    category: 'security',
    multiline: { mode: 'none' },
    extractFields: [
      { fields: ['iptables_chain'], pattern: /\b(?<iptables_chain>INPUT|OUTPUT|FORWARD|PREROUTING|POSTROUTING)\b/i },
      { fields: ['iptables_action'], pattern: /\b(?<iptables_action>DROP|ACCEPT|REJECT|ALLOW|DENY)\b/i },
      {
        fields: ['src_ip', 'dst_ip', 'proto', 'dpt'],
        pattern:
          /\bSRC=(?<src_ip>[0-9a-fA-F:.]+)\b.*?\bDST=(?<dst_ip>[0-9a-fA-F:.]+)\b(?:.*?\bPROTO=(?<proto>[A-Za-z0-9]+)\b)?(?:.*?\bDPT=(?<dpt>\d+)\b)?/i,
      },
    ],
  },
  {
    id: 'cron',
    label: 'Cron / Scheduled Jobs',
    description: 'Parses cron execution lines and keeps each scheduler line as a standalone event.',
    category: 'system',
    multiline: { mode: 'none' },
    extractFields: [
      { fields: ['cron_user', 'cron_cmd'], pattern: /\((?<cron_user>[^)]+)\)\s+CMD\s+\((?<cron_cmd>.+)\)$/i },
      { fields: ['cron_user', 'cron_action'], pattern: /\((?<cron_user>[^)]+)\)\s+(?<cron_action>START|END|RELOAD|DEFERRED)\b/i },
      { fields: ['cron_job_id'], pattern: /\bjob(?:_id)?[=: ](?<cron_job_id>[A-Za-z0-9_.:-]+)\b/i },
    ],
    under_the_hood: [
      'Turns off backend multiline joining for cron events (cron lines are usually standalone).',
      'Extracts cron user/action/command identifiers from canonical cron formats.',
    ],
    result_changes: [
      'More predictable one-line-per-job event representation.',
      'Improved reporting and filtering for scheduled task failures.',
    ],
  },
  {
    id: 'postfix',
    label: 'Postfix MTA',
    description: 'Extracts queue ID, sender/recipient, relay, and delivery status.',
    category: 'messaging',
    multiline: { mode: 'none' },
    extractFields: [
      { fields: ['postfix_queue_id', 'postfix_message'], pattern: /\b(?<postfix_queue_id>[A-F0-9]{8,12}):\s*(?<postfix_message>.+)$/i },
      { fields: ['mail_from', 'mail_to', 'mail_status'], pattern: /\bfrom=<(?<mail_from>[^>]*)>.*?\bto=<(?<mail_to>[^>]*)>.*?\bstatus=(?<mail_status>[a-z_]+)\b/i },
      { fields: ['mail_relay'], pattern: /\brelay=(?<mail_relay>[^,\s]+)/i },
    ],
  },
  {
    id: 'haproxy',
    label: 'HAProxy',
    description: 'Extracts frontend/backend/server, status, timing, and HTTP request path.',
    category: 'webserver',
    multiline: { mode: 'none' },
    extractFields: [
      {
        fields: ['frontend', 'backend', 'server_name', 'total_time', 'http_status'],
        pattern:
          /\s(?<frontend>[A-Za-z0-9_.-]+)\s+(?<backend>[A-Za-z0-9_.-]+)\/(?<server_name>[A-Za-z0-9_.-]+)\s+\d+\/\d+\/\d+\/\d+\/(?<total_time>\d+)\s+(?<http_status>\d{3})\s+/,
      },
      { fields: ['http_method', 'http_path'], pattern: /"(?<http_method>GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\s+(?<http_path>\S+)\s+HTTP\/[0-9.]+"/i },
    ],
  },
  {
    id: 'common',
    label: 'Common (Safe Generic)',
    description: 'Conservative generic profile for unknown systems with minimal, predictable multiline behavior.',
    category: 'general',
    multiline: { mode: 'indent_only' },
    extractFields: [
      { fields: ['common_request_id'], pattern: /\b(?:request|req|trace|session)[-_ ]?id[=: ](?<common_request_id>[A-Za-z0-9-]+)\b/i },
      { fields: ['common_user'], pattern: /\b(?:user|uid|account)[=: ](?<common_user>[A-Za-z0-9_.@-]+)\b/i },
      { fields: ['common_error_code'], pattern: /\b(?:error|err|code)[=: ](?<common_error_code>[A-Za-z0-9_.-]+)\b/i },
    ],
    under_the_hood: [
      'Uses only indentation-based multiline joining (stack-like continuations), no aggressive heuristics.',
      'Keeps unknown source logs mostly untouched while extracting a few common IDs (request/user/error code).',
    ],
    result_changes: [
      'Safer default for mixed or unknown log formats.',
      'Reduces accidental joins while still improving searchability with common metadata.',
    ],
  },
];

const PROFILE_MAP = new Map(PROFILE_REGISTRY.map((profile) => [profile.id, profile]));

export function getParseProfile(id: string): ParseProfile | undefined {
  return PROFILE_MAP.get(id);
}

export function listParseProfiles(): ParseProfile[] {
  return [...PROFILE_REGISTRY];
}

export function listParseProfileSummaries(): ParseProfileSummary[] {
  return PROFILE_REGISTRY.map((profile) => ({
    id: profile.id,
    label: profile.label,
    description: profile.description,
    category: profile.category,
    multiline_mode: profile.multiline.mode,
    multiline_start_pattern: profile.multiline.startPattern,
    extracted_fields: Array.from(
      new Set((profile.extractFields ?? []).flatMap((rule) => rule.fields)),
    ),
    under_the_hood: profile.under_the_hood ?? buildDefaultUnderTheHood(profile),
    result_changes: profile.result_changes ?? buildDefaultResultChanges(profile),
  }));
}

function buildDefaultUnderTheHood(profile: ParseProfile): string[] {
  const lines: string[] = [];
  if (profile.multiline.mode === 'none') {
    lines.push('Disables backend generic multiline joining for this source.');
  } else if (profile.multiline.mode === 'indent_only') {
    lines.push('Joins only indentation-based continuation lines (conservative stacktrace mode).');
  } else {
    lines.push(
      profile.multiline.startPattern
        ? `Starts new events using custom start regex: ${profile.multiline.startPattern}`
        : 'Starts new events using profile timestamp-head detection.',
    );
  }
  if ((profile.extractFields ?? []).length > 0) {
    lines.push('Runs profile regex extraction and stores named captures inside event raw metadata.');
  }
  if (profile.severityOverrides) {
    lines.push('Applies profile-specific severity normalization/overrides.');
  }
  return lines;
}

function buildDefaultResultChanges(profile: ParseProfile): string[] {
  const lines: string[] = [];
  if (profile.multiline.mode === 'none') {
    lines.push('Standalone lines remain standalone (minimizes false merges).');
  } else if (profile.multiline.mode === 'indent_only') {
    lines.push('Only obvious continuation blocks are merged, keeping unrelated lines separate.');
  } else {
    lines.push('Profile-specific head detection makes multiline grouping more predictable for this source.');
  }
  if ((profile.extractFields ?? []).length > 0) {
    lines.push('Additional parsed metadata fields become available for search/filtering.');
  }
  return lines;
}

function canonicalizeSeverity(value: string): string {
  const key = value.trim().toLowerCase();
  return SEVERITY_CANONICAL[key] ?? key;
}

function mergeNamedGroups(
  target: Record<string, unknown>,
  groups: Record<string, string | undefined>,
  mode: MatchMode,
): boolean {
  let changed = false;
  for (const [key, raw] of Object.entries(groups)) {
    const val = raw?.trim();
    if (!val) continue;
    if (mode === 'all') {
      const existing = target[key];
      const arr = Array.isArray(existing)
        ? [...existing]
        : existing === undefined || existing === null
          ? []
          : [String(existing)];
      if (!arr.includes(val)) {
        arr.push(val);
        target[key] = arr;
        changed = true;
      }
    } else if (target[key] === undefined || target[key] === null || target[key] === '') {
      target[key] = val;
      changed = true;
    }
  }
  return changed;
}

function maybeApplySeverityOverride(event: NormalizedEvent, profile: ParseProfile): void {
  const overrides = profile.severityOverrides;
  if (!overrides) return;

  const normalizeByOverride = (value: string): string | null => {
    const key = value.trim().toLowerCase();
    const mapped = overrides[key];
    if (mapped) return canonicalizeSeverity(mapped);
    const canonical = canonicalizeSeverity(value);
    return canonical.length > 0 ? canonical : null;
  };

  if (typeof event.severity === 'string' && event.severity.trim().length > 0) {
    const mapped = normalizeByOverride(event.severity);
    if (mapped) event.severity = mapped;
    return;
  }

  if (!event.raw || typeof event.raw !== 'object' || Array.isArray(event.raw)) return;
  const rawObj = event.raw as Record<string, unknown>;
  for (const key of ['severity', 'level', 'cisco_severity', 'mysql_level', 'apache_level', 'nginx_level']) {
    const val = rawObj[key];
    if (typeof val !== 'string' || val.trim().length === 0) continue;
    const mapped = normalizeByOverride(val);
    if (mapped) {
      event.severity = mapped;
      return;
    }
  }
}

/**
 * Applies parse-profile extraction patterns to the normalized event message.
 *
 * Extracted fields are appended to `event.raw` using named regex capture groups.
 * Existing fields are preserved (first match wins for `onMatch=first`).
 */
export function applyProfileExtraction(event: NormalizedEvent, profile: ParseProfile): void {
  if (!profile.extractFields || profile.extractFields.length === 0) {
    maybeApplySeverityOverride(event, profile);
    return;
  }

  const rawObj: Record<string, unknown> =
    event.raw && typeof event.raw === 'object' && !Array.isArray(event.raw)
      ? { ...(event.raw as Record<string, unknown>) }
      : {};

  let changed = false;
  for (const rule of profile.extractFields) {
    const mode = rule.onMatch ?? 'first';
    if (mode === 'all') {
      const flags = rule.pattern.flags.includes('g')
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`;
      const re = new RegExp(rule.pattern.source, flags);
      for (const match of event.message.matchAll(re)) {
        if (match.groups) {
          changed = mergeNamedGroups(rawObj, match.groups as Record<string, string | undefined>, mode) || changed;
        }
      }
    } else {
      rule.pattern.lastIndex = 0;
      const match = rule.pattern.exec(event.message);
      if (match?.groups) {
        changed = mergeNamedGroups(rawObj, match.groups as Record<string, string | undefined>, mode) || changed;
      }
    }
  }

  if (changed) {
    event.raw = rawObj;
  }

  maybeApplySeverityOverride(event, profile);
}
