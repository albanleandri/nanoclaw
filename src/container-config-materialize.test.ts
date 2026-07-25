import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR } from './config.js';
import {
  buildRequestSystemInstructions,
  materializeContainerJson,
  materializeSessionRuntimeJson,
} from './container-config.js';
import {
  closeDb,
  createAgentGroup,
  createContainerConfig,
  createSession,
  getAgentGroupMemoryControl,
  initTestDb,
  runMigrations,
  transitionAgentGroupMemoryControl,
} from './db/index.js';
import type { AgentGroup, ContainerConfigRow, Session } from './types.js';

const group: AgentGroup = {
  id: 'ag-profile-materialize',
  name: 'Profile Materialize',
  folder: 'profile-materialize-test',
  agent_provider: 'codex',
  created_at: '2026-06-20T00:00:00.000Z',
};

function configRow(overrides: Partial<ContainerConfigRow> = {}): ContainerConfigRow {
  return {
    agent_group_id: group.id,
    provider: 'codex',
    model: 'gpt-5-codex',
    effort: 'medium',
    image_tag: null,
    assistant_name: 'Reviewer',
    max_messages_per_prompt: null,
    skills: '["calendar"]',
    mcp_servers: JSON.stringify({
      search: { command: 'npx', args: ['search'], instructions: 'search with care' },
    }),
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'disabled',
    shared_resources: '["knowledge"]',
    updated_at: '2026-06-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('materializeContainerJson agent profile', () => {
  beforeEach(() => {
    fs.rmSync(path.join(GROUPS_DIR, group.folder), { recursive: true, force: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup(group);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(path.join(GROUPS_DIR, group.folder), { recursive: true, force: true });
  });

  it('embeds the neutral agent profile in returned and written container config', () => {
    createContainerConfig(configRow());

    const config = materializeContainerJson(group.id);
    const written = JSON.parse(
      fs.readFileSync(path.join(GROUPS_DIR, group.folder, 'container.json'), 'utf-8'),
    ) as typeof config;

    expect(config.agentProfile).toEqual({
      agentGroupId: group.id,
      groupName: group.name,
      assistantName: 'Reviewer',
      memory: {
        workspacePath: '/workspace/agent',
        localMemoryFile: 'CLAUDE.local.md',
        neutralMemoryRoot: '/workspace/agent/memory',
        indexPath: 'index.md',
        definitionPath: 'system/definition.md',
        conversationsPath: '/workspace/agent/conversations',
        mode: 'disabled',
        access: 'none',
        okfVersion: '0.1',
        indexMaxBytes: 12 * 1024,
        definitionMaxBytes: 8 * 1024,
        renderedMaxBytes: 24 * 1024,
      },
      tools: {
        skills: ['calendar'],
        mcpServers: {
          search: { command: 'npx', args: ['search'], instructions: 'search with care' },
        },
        cliScope: 'disabled',
      },
      resources: {
        sharedResources: ['knowledge'],
      },
    });
    expect(written.agentProfile).toEqual(config.agentProfile);
    expect(fs.statSync(path.join(GROUPS_DIR, group.folder, 'container.json')).mode & 0o777).toBe(0o600);
  });

  it('keeps the neutral profile consistent with the top-level config fields it mirrors', () => {
    createContainerConfig(configRow());

    const config = materializeContainerJson(group.id);
    const profile = config.agentProfile;

    // The profile is derived state. These fields are duplicated into the profile
    // for introspection and must never drift from their top-level source.
    expect(profile).toBeDefined();
    expect(profile?.agentGroupId).toBe(config.agentGroupId);
    expect(profile?.groupName).toBe(config.groupName);
    expect(profile?.assistantName).toBe(config.assistantName);
    expect(profile?.tools.skills).toEqual(config.skills);
    expect(profile?.tools.mcpServers).toEqual(config.mcpServers);
    expect(profile?.tools.cliScope).toBe(config.cliScope);
    expect(profile?.resources.sharedResources).toEqual(config.sharedResources);
  });

  it('writes a restrictive session-specific runtime config without changing the group snapshot', () => {
    createContainerConfig(configRow());
    const groupConfig = materializeContainerJson(group.id);
    const sessionDir = path.join(GROUPS_DIR, group.folder, '.test-session');
    const runtime = materializeSessionRuntimeJson(sessionDir, group, groupConfig, {
      provider: 'claude',
      model: 'session-effective-model',
      effort: 'high',
      runtimeStateKey: 'profile:p1:abc',
    });
    const written = JSON.parse(fs.readFileSync(runtime.path, 'utf8')) as typeof runtime.config;
    const groupSnapshot = JSON.parse(
      fs.readFileSync(path.join(GROUPS_DIR, group.folder, 'container.json'), 'utf8'),
    ) as typeof runtime.config;

    expect(written.model).toBe('session-effective-model');
    expect(written.runtimeStateKey).toBe('profile:p1:abc');
    expect(groupSnapshot.model).toBe('gpt-5-codex');
    expect(fs.statSync(runtime.path).mode & 0o777).toBe(0o600);
  });

  it('materializes session-specific memory mode and writer access without changing the group snapshot', () => {
    createContainerConfig(configRow());
    const writer: Session = {
      id: 'memory-writer',
      agent_group_id: group.id,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: group.created_at,
    };
    const reader = { ...writer, id: 'memory-reader' };
    createSession(writer);
    createSession(reader);
    const initial = getAgentGroupMemoryControl(group.id)!;
    transitionAgentGroupMemoryControl(group.id, initial.version, {
      mode: 'shadow',
      migrationState: 'staging',
      writerSessionId: writer.id,
    });

    const groupConfig = materializeContainerJson(group.id);
    const writerRuntime = materializeSessionRuntimeJson(
      path.join(GROUPS_DIR, group.folder, writer.id),
      group,
      groupConfig,
      { provider: 'claude', runtimeStateKey: 'claude' },
      undefined,
      writer.id,
    );
    const readerRuntime = materializeSessionRuntimeJson(
      path.join(GROUPS_DIR, group.folder, reader.id),
      group,
      groupConfig,
      { provider: 'claude', runtimeStateKey: 'claude' },
      undefined,
      reader.id,
    );

    expect(groupConfig.agentProfile?.memory).toMatchObject({ mode: 'disabled', access: 'none' });
    expect(writerRuntime.config.agentProfile?.memory).toMatchObject({ mode: 'shadow', access: 'read-write' });
    expect(readerRuntime.config.agentProfile?.memory).toMatchObject({ mode: 'shadow', access: 'read-only' });
  });

  it('embeds an explicitly supplied compiled session runtime plan', () => {
    createContainerConfig(configRow());
    const groupConfig = materializeContainerJson(group.id);
    const plan = {
      runtime: { runtimeId: 'openai-protocol-loop', runtimeStateKey: 'profile:p1' },
      capabilities: [
        { id: 'nanoclaw.send-message', adapter: 'protocol-tool' as const, entrypoint: 'tool:send_message' },
      ],
      rejectedCapabilities: [],
      policy: { cliScope: 'group' as const, approvalMode: 'default', writableWorkspace: true },
      instructionSections: [],
    };
    const runtime = materializeSessionRuntimeJson(
      path.join(GROUPS_DIR, group.folder, '.test-plan-session'),
      group,
      groupConfig,
      { provider: 'openai-compatible', runtimeStateKey: 'profile:p1' },
      plan,
    );
    expect(runtime.config.sessionRuntimePlan).toEqual(plan);
  });

  it('marks oversized optional request instructions as omitted instead of truncating silently', () => {
    const instructions = buildRequestSystemInstructions(group, {
      mcpServers: {
        enormous: { command: 'node', instructions: 'x'.repeat(70 * 1024) },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
      cliScope: 'disabled',
      assistantName: 'Reviewer',
      groupName: group.name,
      agentGroupId: group.id,
    });

    expect(Buffer.byteLength(instructions, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(instructions).toContain('# Omitted for size');
    expect(instructions).toContain('MCP Server: enormous');
    expect(instructions).not.toContain('persistent Claude memory');
  });
});
