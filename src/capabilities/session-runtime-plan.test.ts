import { describe, expect, it } from 'vitest';

import { requireRuntimeDescriptor } from '../providers/runtime-descriptor-registry.js';
import '../providers/runtime-descriptors/index.js';
import type { EffectiveRuntimeSelection } from '../providers/runtime-descriptor.js';
import type { AvailabilityContext } from './availability.js';
import { compileSessionRuntimePlan, type AgentCapabilityProfile } from './session-runtime-plan.js';

const runtimeDescriptor = requireRuntimeDescriptor('claude-sdk');
const runtime: EffectiveRuntimeSelection = {
  runtimeId: 'claude-sdk',
  model: 'opus',
  runtimeStateKey: 'claude',
};
const policy = { cliScope: 'group' as const, approvalMode: 'default', writableWorkspace: true };
const noServers: AvailabilityContext = { configuredMcpServers: new Set(), writableWorkspace: true };
const withBrowser: AvailabilityContext = {
  configuredMcpServers: new Set(['browser']),
  writableWorkspace: true,
};

function compile(capabilityProfile: AgentCapabilityProfile, availability = noServers) {
  return compileSessionRuntimePlan({
    runtime,
    runtimeDescriptor,
    capabilityProfile,
    availability,
    policy,
  });
}

describe('compileSessionRuntimePlan', () => {
  it('binds required host actions to concrete adapters', () => {
    const plan = compile({
      requested: ['nanoclaw.send-message', 'nanoclaw.schedule-task'],
      allowDegraded: [],
    });
    expect(plan.capabilities.map((item) => item.id)).toEqual(['nanoclaw.send-message', 'nanoclaw.schedule-task']);
    expect(plan.capabilities.every((item) => item.adapter === 'host-action')).toBe(true);
    expect(plan.rejectedCapabilities).toEqual([]);
  });

  it('fails before spawn when a required capability is unavailable', () => {
    expect(() => compile({ requested: ['web.browse'], allowDegraded: [] })).toThrow(
      /web\.browse.*claude-sdk.*availability/i,
    );
  });

  it('records explicitly optional capability loss', () => {
    const plan = compile({ requested: ['web.browse'], allowDegraded: ['web.browse'] });
    expect(plan.capabilities).toEqual([]);
    expect(plan.rejectedCapabilities).toEqual([{ id: 'web.browse', reason: expect.any(String), required: false }]);
  });

  it('includes an available required browser adapter', () => {
    const plan = compile({ requested: ['web.browse'], allowDegraded: [] }, withBrowser);
    expect(plan.capabilities).toEqual([{ id: 'web.browse', adapter: 'mcp', entrypoint: 'mcp:browser' }]);
  });

  it('compiles verified generic runtime host capabilities to protocol tools', () => {
    const genericDescriptor = requireRuntimeDescriptor('openai-protocol-loop');
    const plan = compileSessionRuntimePlan({
      runtime: { runtimeId: genericDescriptor.id, runtimeStateKey: 'profile:p' },
      runtimeDescriptor: genericDescriptor,
      capabilityProfile: {
        requested: [
          'nanoclaw.send-message',
          'nanoclaw.schedule-task',
          'nanoclaw.request-agent-task',
          'nanoclaw.report-agent-task-progress',
        ],
        allowDegraded: [],
      },
      availability: noServers,
      endpointCapabilities: { toolCalling: 'native' },
      policy,
    });
    expect(plan.capabilities).toEqual([
      { id: 'nanoclaw.send-message', adapter: 'protocol-tool', entrypoint: 'tool:send_message' },
      { id: 'nanoclaw.schedule-task', adapter: 'protocol-tool', entrypoint: 'tool:schedule_task' },
      { id: 'nanoclaw.request-agent-task', adapter: 'protocol-tool', entrypoint: 'tool:request_agent_task' },
      {
        id: 'nanoclaw.report-agent-task-progress',
        adapter: 'protocol-tool',
        entrypoint: 'tool:report_agent_task_progress',
      },
    ]);
  });
});
