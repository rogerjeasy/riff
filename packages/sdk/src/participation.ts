/** Host presentation preferences: no guest capability or gameplay authority. */
export type ParticipationLanguage = 'en' | 'fr' | 'es' | 'de';
export interface ParticipationSettings {
  revision: number;
  language: ParticipationLanguage | 'inherit';
  reducedMotion: boolean;
  highContrast: boolean;
  effectLabels: boolean;
}
export interface ParticipationInteraction {
  id: string;
  title: string;
  phase: 'running' | 'paused' | 'finished';
  free: boolean;
  instructions: string[];
  objective: string;
  /** The main chat command that contributes (or triggers a stateless effect). */
  command: string;
  /** Team join commands in team order; empty when the interaction has no teams. */
  joinCommands: string[];
  /** Eligible roles exactly as the host engine enforces them; `viewer` means everyone. */
  audience: ('viewer' | 'subscriber' | 'moderator' | 'broadcaster')[];
  /** Collective-goal progress in points; null for every other objective. */
  goal: { target: number; current: number } | null;
  remainingMs: number | null;
  scores: { label: string; score: number }[];
  outcome: string | null;
}
export interface ParticipationView {
  language: ParticipationLanguage;
  stopped: boolean;
  reducedMotion: boolean;
  highContrast: boolean;
  helpCommand: string;
  interactions: ParticipationInteraction[];
}
