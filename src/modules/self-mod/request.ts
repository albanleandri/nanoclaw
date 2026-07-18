/**
 * Delivery-action handlers for agent-initiated self-modification requests.
 *
 * Two actions the container can write into messages_out (via the self-mod
 * MCP tools): install_packages, add_mcp_server. Each one validates input
 * and queues an approval request. The admin's approval triggers the
 * matching approval handler in ./apply.ts, which also performs the
 * required follow-up (rebuild+restart for install_packages, restart-only
 * for add_mcp_server).
 *
 * Host-side sanitization for install_packages is defense-in-depth — the MCP
 * tool validates first. Both layers matter: the DB row carries the payload
 * verbatim through to shell exec on apply.
 */
import { createHash } from 'node:crypto';

import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { MAX_PACKAGES_PER_REQUEST, validatePackageLists } from '../../package-names.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

export async function handleInstallPackages(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'install_packages failed: agent group not found.');
    return;
  }

  let apt: string[];
  let npm: string[];
  try {
    ({ apt, npm } = validatePackageLists(content.apt ?? [], content.npm ?? [], {
      requireOne: true,
      maxCount: MAX_PACKAGES_PER_REQUEST,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid package request';
    notifyAgent(session, `install_packages failed: ${message}.`);
    log.warn('install_packages: invalid package request rejected', { error: message });
    return;
  }
  const reason = (content.reason as string) || '';

  const packageList = [...apt.map((p) => `apt: ${p}`), ...npm.map((p) => `npm: ${p}`)].join(', ');
  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'install_packages',
    payload: { apt, npm, reason },
    title: 'Install Packages Request',
    question: `Agent "${agentGroup.name}" is attempting to install a package + rebuild container:\n${packageList}${reason ? `\nReason: ${reason}` : ''}`,
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

const MAX_MCP_ARGS = 32;
const MAX_MCP_ENV_VARS = 32;
const MCP_APPROVAL_CARD_MAX_BYTES = 1500;
const MCP_PAYLOAD_MAX_BYTES = 16_384;
const SECRET_ENV_KEY_RE = /(TOKEN|SECRET|PASSW(OR)?D|API_?KEY|APIKEY|CREDENTIAL|PRIVATE_?KEY|AUTH)/i;
const SECRET_VALUE_RE = /^(sk-|ghp_|github_pat_|xox[a-z]-|AKIA|-----BEGIN )/;

function redactSecret(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `<redacted: ${Buffer.byteLength(value, 'utf8')} bytes, sha256 ${digest}>`;
}

/** Render formatting/control characters visibly so payload text cannot escape a code fence. */
export function escapeInvisibles(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029`]/gu, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0xffff ? `\\u{${codePoint.toString(16)}}` : `\\u${codePoint.toString(16).padStart(4, '0')}`;
  });
}

export async function handleAddMcpServer(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    notifyAgent(session, 'add_mcp_server failed: agent group not found.');
    return;
  }
  const serverName = content.name;
  const command = content.command;
  if (typeof serverName !== 'string' || !serverName || typeof command !== 'string' || !command) {
    notifyAgent(session, 'add_mcp_server failed: name and command are required.');
    return;
  }
  if (content.args !== undefined && !isStringArray(content.args)) {
    notifyAgent(session, 'add_mcp_server failed: args must be an array of strings.');
    return;
  }
  if (content.env !== undefined && !isStringRecord(content.env)) {
    notifyAgent(session, 'add_mcp_server failed: env must be a map of string keys to string values.');
    return;
  }

  const args = content.args ?? [];
  const env = content.env ?? {};
  if (args.length > MAX_MCP_ARGS) {
    notifyAgent(session, `add_mcp_server failed: max ${MAX_MCP_ARGS} args per server.`);
    return;
  }
  if (Object.keys(env).length > MAX_MCP_ENV_VARS) {
    notifyAgent(session, `add_mcp_server failed: max ${MAX_MCP_ENV_VARS} env vars per server.`);
    return;
  }

  const payload = { name: serverName, command, args, env };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MCP_PAYLOAD_MAX_BYTES) {
    notifyAgent(session, `add_mcp_server failed: payload exceeds ${MCP_PAYLOAD_MAX_BYTES} bytes.`);
    return;
  }

  const displayArgs = args.map((arg) => (SECRET_VALUE_RE.test(arg) ? redactSecret(arg) : arg));
  const displayEnv = Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      SECRET_ENV_KEY_RE.test(key) || SECRET_VALUE_RE.test(value) ? redactSecret(value) : value,
    ]),
  );
  const question =
    `Agent "${agentGroup.name}" is attempting to add a new MCP server:\n` +
    '```\n' +
    `name: ${escapeInvisibles(JSON.stringify(serverName))}\n` +
    `command: ${escapeInvisibles(JSON.stringify(command))}\n` +
    `args: ${escapeInvisibles(JSON.stringify(displayArgs))}\n` +
    `env: ${escapeInvisibles(JSON.stringify(displayEnv))}\n` +
    '```';
  if (Buffer.byteLength(question, 'utf8') > MCP_APPROVAL_CARD_MAX_BYTES) {
    notifyAgent(
      session,
      `add_mcp_server failed: rendered approval card exceeds ${MCP_APPROVAL_CARD_MAX_BYTES} bytes — trim args/env.`,
    );
    return;
  }

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'add_mcp_server',
    payload,
    title: 'Add MCP Request',
    question,
  });
}
