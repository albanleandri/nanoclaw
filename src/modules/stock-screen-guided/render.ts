import { normalizeOptions } from '../../channels/ask-question.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { createPendingHostQuestion, deletePendingHostQuestion } from '../../db/sessions.js';
import type { GuidedQuestion } from './options.js';
import type { ScreenMarketWizard, WizardPreview } from './state.js';

export function generateQuestionId(prefix = 'smq'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildQuestionPayload(
  question: GuidedQuestion,
  questionId: string,
  overrideQuestion?: string,
): Record<string, unknown> {
  return {
    type: 'ask_question',
    questionId,
    title: question.title,
    question: overrideQuestion ?? question.question,
    options: question.options.map((option) => option.label),
    multiple: question.multiple,
  };
}

export function buildPreviewQuestion(preview: WizardPreview): string {
  const sample = preview.sample.length ? preview.sample.join(', ') : 'none';
  return `Found ${preview.total} tickers matching your filters. Sample: ${sample}. Screen them all now?`;
}

export function buildTextPayload(text: string): string {
  return JSON.stringify({ text });
}

export async function deliverText(wizard: ScreenMarketWizard, text: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('delivery adapter is not ready');
  await adapter.deliver(wizard.channelType, wizard.platformId, wizard.threadId, 'chat', buildTextPayload(text));
}

export async function deliverQuestion(
  wizard: ScreenMarketWizard,
  question: GuidedQuestion,
  questionId: string,
  overrideQuestion?: string,
): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('delivery adapter is not ready');
  const payload = buildQuestionPayload(question, questionId, overrideQuestion);
  createPendingHostQuestion({
    question_id: questionId,
    owner_type: 'screen_market_wizard',
    owner_id: wizard.id,
    title: question.title,
    options: normalizeOptions(payload.options as never),
    created_at: new Date().toISOString(),
  });
  try {
    await adapter.deliver(wizard.channelType, wizard.platformId, wizard.threadId, 'chat', JSON.stringify(payload));
  } catch (err) {
    deletePendingHostQuestion(questionId);
    throw err;
  }
}
