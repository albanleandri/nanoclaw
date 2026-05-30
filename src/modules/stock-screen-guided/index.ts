import { deletePendingHostQuestion } from '../../db/sessions.js';
import { SCREEN_MARKET_GUIDED_HOST } from '../../config.js';
import { startJob } from '../../jobs/runner.js';
import { registerResponseHandler } from '../../response-registry.js';
import { setCommandInterceptor } from '../../router.js';
import { log } from '../../log.js';
import {
  assertValidSelection,
  getQuestion,
  mergeAnswersToParams,
  nextStep,
  normalizeStepSelection,
  type WizardStep,
} from './options.js';
import { resolvePreview } from './resolver.js';
import { buildPreviewQuestion, deliverQuestion, deliverText, generateQuestionId } from './render.js';
import {
  advanceWizard,
  cancelWizard,
  expireOldWizards,
  expireWizard,
  getWizard,
  getWizardQuestion,
  markWizardFailed,
  markWizardStarted,
  recordWizardQuestion,
  savePreview,
  saveStepAnswer,
  startWizard,
  type ScreenMarketWizard,
} from './state.js';

function isExactScreenMarket(text: string): boolean {
  return text.trim().toLowerCase() === '/screen-market';
}

function parseSelected(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

async function sendStepQuestion(wizard: ScreenMarketWizard, step: WizardStep): Promise<void> {
  const question = getQuestion(step);
  const questionId = generateQuestionId();
  recordWizardQuestion(wizard.id, step, questionId);
  await deliverQuestion(wizard, question, questionId);
}

async function sendConfirmation(wizard: ScreenMarketWizard): Promise<void> {
  if (!wizard.preview) throw new Error('cannot confirm without preview');
  const question = getQuestion('confirm');
  const questionId = generateQuestionId();
  recordWizardQuestion(wizard.id, 'confirm', questionId);
  await deliverQuestion(wizard, question, questionId, buildPreviewQuestion(wizard.preview));
}

async function startScreenJob(wizard: ScreenMarketWizard): Promise<void> {
  const params = { ...mergeAnswersToParams(wizard.answers), batchSize: 50, delaySec: 0.5 };
  const job = startJob({
    type: 'stock_market_screen',
    params,
    agentGroupId: wizard.agentGroupId,
    sessionId: wizard.sessionId,
    messagingGroupId: wizard.messagingGroupId,
    channelType: wizard.channelType,
    platformId: wizard.platformId,
    threadId: wizard.threadId,
    requestedBy: wizard.requestedBy,
  });
  markWizardStarted(wizard.id, job.id);
  await deliverText(wizard, 'Screen started. I will send progress here and a final result when it is done.');
}

async function handleWizardResponse(questionId: string, selectedOption: string): Promise<boolean> {
  const ref = getWizardQuestion(questionId);
  if (!ref) return false;

  deletePendingHostQuestion(questionId);
  const wizard = getWizard(ref.wizardId);
  if (!wizard) return true;

  if (
    new Date(wizard.expiresAt).getTime() <= Date.now() ||
    (wizard.status !== 'active' && wizard.status !== 'preview')
  ) {
    expireWizard(wizard.id);
    await deliverText(wizard, 'That screen-market setup expired. Send /screen-market to start again.');
    return true;
  }

  try {
    const selected = parseSelected(selectedOption);
    assertValidSelection(ref.step, selected);

    if (ref.step === 'confirm') {
      if (selected[0] === 'Cancel') {
        cancelWizard(wizard.id);
        await deliverText(wizard, 'Screening cancelled.');
        return true;
      }
      if (selected[0] !== 'Yes - screen them') throw new Error(`Invalid confirmation option: ${selected[0] ?? ''}`);
      await startScreenJob(wizard);
      return true;
    }

    const normalized = normalizeStepSelection(ref.step, selected);
    const answered = saveStepAnswer(wizard.id, ref.step, normalized);
    const next = nextStep(ref.step);
    if (!next) throw new Error(`No next step after ${ref.step}`);

    if (next === 'confirm') {
      const params = mergeAnswersToParams(answered.answers);
      const preview = await resolvePreview(params);
      const previewed = savePreview(wizard.id, preview);
      await sendConfirmation(previewed);
      return true;
    }

    const advanced = advanceWizard(wizard.id, next);
    await sendStepQuestion(advanced, next);
    return true;
  } catch (err) {
    markWizardFailed(wizard.id);
    log.error('Screen-market guided wizard failed', { wizardId: wizard.id, questionId, err });
    await deliverText(
      wizard,
      `Could not continue screen-market setup: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true;
  }
}

if (SCREEN_MARKET_GUIDED_HOST) {
  setCommandInterceptor(async ({ text, agent, session, messagingGroup, deliveryAddress, userId }) => {
    if (!isExactScreenMarket(text)) return false;
    expireOldWizards();
    const wizard = startWizard({
      agentGroupId: agent.agent_group_id,
      sessionId: session.id,
      messagingGroupId: messagingGroup.id,
      channelType: deliveryAddress.channelType,
      platformId: deliveryAddress.platformId,
      threadId: deliveryAddress.threadId,
      requestedBy: userId,
    });
    try {
      await sendStepQuestion(wizard, 'market_cap');
    } catch (err) {
      markWizardFailed(wizard.id);
      log.error('Failed to start screen-market guided wizard', { wizardId: wizard.id, err });
      await deliverText(wizard, 'Could not open screen-market options. Please try again.').catch(() => undefined);
    }
    return true;
  });
}

registerResponseHandler(async (payload) => handleWizardResponse(payload.questionId, payload.value));
