import type { StockMarketScreenParams } from '../../jobs/stock-market-screen.js';

export type WizardStep = 'market_cap' | 'sector' | 'geography' | 'currency' | 'confirm';
export type ParamKey = 'marketCaps' | 'sectors' | 'countries' | 'exchanges' | 'currencies';

export interface GuidedOption {
  label: string;
  marketCaps?: string[];
  sectors?: string[];
  countries?: string[];
  exchanges?: string[];
  currencies?: string[];
  clears?: ParamKey[];
}

export interface GuidedQuestion {
  step: WizardStep;
  title: 'Screen Market';
  question: string;
  multiple: boolean;
  options: GuidedOption[];
}

export type WizardAnswers = Partial<Record<WizardStep, string[]>>;

const MARKET_CAPS = ['Mega Cap', 'Large Cap', 'Mid Cap', 'Small Cap', 'Micro Cap', 'Nano Cap'];

export const GUIDED_QUESTIONS: Record<WizardStep, GuidedQuestion> = {
  market_cap: {
    step: 'market_cap',
    title: 'Screen Market',
    question: 'Which market cap tier should we focus on?',
    multiple: true,
    options: [
      ...MARKET_CAPS.map((cap) => ({ label: cap, marketCaps: [cap] })),
      { label: 'All cap tiers', clears: ['marketCaps'] },
    ],
  },
  sector: {
    step: 'sector',
    title: 'Screen Market',
    question: 'Filter by sector?',
    multiple: true,
    options: [
      { label: 'Communication Services', sectors: ['Communication Services'] },
      { label: 'Consumer Discretionary', sectors: ['Consumer Discretionary'] },
      { label: 'Consumer Staples', sectors: ['Consumer Staples'] },
      { label: 'Energy', sectors: ['Energy'] },
      { label: 'Financials', sectors: ['Financials'] },
      { label: 'Health Care', sectors: ['Health Care'] },
      { label: 'Industrials', sectors: ['Industrials'] },
      { label: 'Information Technology', sectors: ['Information Technology'] },
      { label: 'Materials', sectors: ['Materials'] },
      { label: 'Real Estate & Utilities', sectors: ['Real Estate', 'Utilities'] },
      { label: 'All sectors', clears: ['sectors'] },
    ],
  },
  geography: {
    step: 'geography',
    title: 'Screen Market',
    question: 'Which market should we include?',
    multiple: true,
    options: [
      { label: 'US (NASDAQ + NYSE)', exchanges: ['nasdaq', 'nyse'] },
      {
        label: 'Europe Core',
        countries: [
          'France',
          'Germany',
          'Netherlands',
          'Switzerland',
          'Belgium',
          'Spain',
          'Italy',
          'Austria',
          'Portugal',
        ],
      },
      { label: 'Nordics', countries: ['Sweden', 'Denmark', 'Finland', 'Norway'] },
      { label: 'UK + Ireland', countries: ['United Kingdom', 'Ireland'] },
      { label: 'Japan', countries: ['Japan'] },
      { label: 'Developed Asia', countries: ['Hong Kong', 'Singapore', 'South Korea', 'Taiwan'] },
      { label: 'China', countries: ['China'] },
      { label: 'Canada', countries: ['Canada'] },
      { label: 'Australia + NZ', countries: ['Australia', 'New Zealand'] },
      { label: 'All markets', clears: ['countries', 'exchanges'] },
    ],
  },
  currency: {
    step: 'currency',
    title: 'Screen Market',
    question: 'Filter by currency?',
    multiple: true,
    options: [
      { label: 'USD (US Dollar)', currencies: ['USD'] },
      { label: 'EUR (Euro)', currencies: ['EUR'] },
      { label: 'GBP (British Pound)', currencies: ['GBP'] },
      { label: 'JPY (Japanese Yen)', currencies: ['JPY'] },
      { label: 'CAD (Canadian Dollar)', currencies: ['CAD'] },
      { label: 'AUD (Australian Dollar)', currencies: ['AUD'] },
      { label: 'CHF (Swiss Franc)', currencies: ['CHF'] },
      { label: 'HKD (Hong Kong Dollar)', currencies: ['HKD'] },
      { label: 'CNY (Chinese Yuan)', currencies: ['CNY'] },
      { label: 'All currencies', clears: ['currencies'] },
    ],
  },
  confirm: {
    step: 'confirm',
    title: 'Screen Market',
    question: 'Screen them all now?',
    multiple: false,
    options: [{ label: 'Yes - screen them' }, { label: 'Cancel' }],
  },
};

export const STEP_ORDER: WizardStep[] = ['market_cap', 'sector', 'geography', 'currency', 'confirm'];

export function getQuestion(step: WizardStep): GuidedQuestion {
  return GUIDED_QUESTIONS[step];
}

export function nextStep(step: WizardStep): WizardStep | null {
  const idx = STEP_ORDER.indexOf(step);
  return idx >= 0 && idx < STEP_ORDER.length - 1 ? STEP_ORDER[idx + 1] : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function optionsByLabel(step: WizardStep): Map<string, GuidedOption> {
  return new Map(GUIDED_QUESTIONS[step].options.map((option) => [option.label, option]));
}

function concreteOptions(step: WizardStep): GuidedOption[] {
  return GUIDED_QUESTIONS[step].options.filter((option) => !option.clears);
}

function stepParamKeys(step: WizardStep): ParamKey[] {
  if (step === 'market_cap') return ['marketCaps'];
  if (step === 'sector') return ['sectors'];
  if (step === 'geography') return ['countries', 'exchanges'];
  if (step === 'currency') return ['currencies'];
  return [];
}

export function normalizeStepSelection(step: WizardStep, selectedLabels: string[]): string[] {
  const question = GUIDED_QUESTIONS[step];
  if (!question.multiple) return selectedLabels.slice(0, 1);
  if (selectedLabels.length === 0) return [];

  const byLabel = optionsByLabel(step);
  const selected = unique(selectedLabels).filter((label) => byLabel.has(label));
  const hasAll = selected.some((label) => byLabel.get(label)?.clears?.length);
  if (hasAll) return [];

  const concreteLabels = concreteOptions(step).map((option) => option.label);
  if (concreteLabels.every((label) => selected.includes(label))) return [];
  return selected;
}

export function assertValidSelection(step: WizardStep, selectedLabels: string[]): void {
  const byLabel = optionsByLabel(step);
  for (const label of selectedLabels) {
    if (!byLabel.has(label)) throw new Error(`Invalid ${step} option: ${label}`);
  }
}

export function mergeAnswersToParams(answers: WizardAnswers): StockMarketScreenParams {
  const params: StockMarketScreenParams = {};
  for (const step of STEP_ORDER) {
    if (step === 'confirm') continue;
    const labels = answers[step] ?? [];
    if (labels.length === 0) continue;
    const byLabel = optionsByLabel(step);
    const patch: Partial<StockMarketScreenParams> = {};
    for (const label of labels) {
      const option = byLabel.get(label);
      if (!option) continue;
      patch.marketCaps = [...(patch.marketCaps ?? []), ...(option.marketCaps ?? [])];
      patch.sectors = [...(patch.sectors ?? []), ...(option.sectors ?? [])];
      patch.countries = [...(patch.countries ?? []), ...(option.countries ?? [])];
      patch.exchanges = [...(patch.exchanges ?? []), ...(option.exchanges ?? [])];
      patch.currencies = [...(patch.currencies ?? []), ...(option.currencies ?? [])];
    }
    for (const key of stepParamKeys(step)) {
      const values = unique((patch[key] as string[] | undefined) ?? []);
      if (values.length > 0) (params as Record<string, string[]>)[key] = values;
    }
  }
  return params;
}

export function labelsForStep(step: WizardStep): string[] {
  return GUIDED_QUESTIONS[step].options.map((option) => option.label);
}
