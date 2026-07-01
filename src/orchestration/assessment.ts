import type { TaskAssessment } from './types.js';

export function assessDirectTask(input: { kind: string; text: string }): TaskAssessment {
  const text = input.text.trim();
  const taskClass: TaskAssessment['taskClass'] =
    input.kind === 'task'
      ? 'scheduled_work'
      : /\b(edit|implement|fix|code|test)\b/i.test(text)
        ? 'software_change'
        : /\b(analy[sz]e|compare|review|investigate)\b/i.test(text)
          ? 'analysis'
          : text.endsWith('?')
            ? 'lookup'
            : 'conversation';
  return {
    version: 1,
    taskClass,
    urgency: input.kind === 'task' ? 'background' : 'interactive',
    complexity: text.length > 4_000 ? 'complex' : text.length > 500 ? 'bounded' : 'trivial',
    reversibility: 'reversible',
    trustRisk: 'low',
    verificationNeed: taskClass === 'software_change' ? 'light' : 'none',
  };
}
