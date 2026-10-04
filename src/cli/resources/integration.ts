import { invokeGrantedHostIntegration } from '../../integrations/invocation-surface.js';
import { renderHostIntegrationResult } from '../../integrations/plugin.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'host integration invocation',
  plural: 'integration',
  table: 'not_applicable',
  description:
    'Invoke an exact operation through an authorized trusted-host integration profile. This does not expose URLs, credentials, or plugin administration.',
  idColumn: 'not_applicable',
  columns: [],
  operations: {},
  customOperations: {
    invoke: {
      access: 'open',
      description:
        'Invoke a registered adapter version and operation using JSON validated by that adapter. If exactly one profile is granted it is selected automatically.',
      args: [
        { name: 'adapter', type: 'string', description: 'Registered adapter ID.', required: true },
        {
          name: 'adapter_version',
          type: 'number',
          description: 'Exact registered adapter version.',
          required: true,
        },
        { name: 'operation', type: 'string', description: 'Registered operation name.', required: true },
        {
          name: 'profile',
          type: 'string',
          description: 'Optional non-secret profile name when more than one authorized profile matches.',
        },
        { name: 'input', type: 'json', description: 'Operation input JSON.', default: {} },
      ],
      examples: [
        'ncl integration invoke --adapter records --adapter-version 1 --operation records.read --input \'{"limit":10}\'',
      ],
      handler: (args, caller) =>
        invokeGrantedHostIntegration({
          caller,
          adapterId: String(args.adapter),
          adapterVersion: Number(args.adapter_version),
          operation: String(args.operation),
          profile: args.profile === undefined ? undefined : String(args.profile),
          input: args.input,
        }),
      formatHuman: (result) =>
        renderHostIntegrationResult(result as Awaited<ReturnType<typeof invokeGrantedHostIntegration>>),
    },
  },
});
