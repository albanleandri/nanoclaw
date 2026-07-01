export const ADVANCED_ACCEPTANCE_FIXTURES = [
  {
    id: 'transient-pre-tool-failure',
    expected: 'fallback_candidate_may_be_evaluated',
  },
  {
    id: 'post-tool-failure',
    expected: 'stop_without_fallback',
  },
  {
    id: 'cancellation-before-dispatch',
    expected: 'remain_cancelled',
  },
  {
    id: 'crash-with-unknown-side-effect-state',
    expected: 'stop_for_operator_review',
  },
  {
    id: 'conflicting-reference-outputs',
    expected: 'treat_as_untrusted_evidence_without_side_effect_authority',
  },
  {
    id: 'exhausted-attempt-token-cost-or-time-budget',
    expected: 'stop_without_new_attempt',
  },
] as const;
