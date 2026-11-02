import type { ExperienceDefinition, SessionSnapshot } from '../lib/types.js';
import { sessionSeconds, sessionText, type SessionLanguage } from './mechanics-copy.js';

/*
 * Text-first presentation of definition version 3 formats (audience mural, staged
 * composition vote, educational group challenge) for the shared session HUD and the stream
 * scoreboard. Everything is derived from host-validated canonical state; viewers only ever
 * chose from the definition's bounded sets, so the only text shown is creator-authored or
 * reviewed copy, always set through textContent or attributes. No audio is produced.
 */

/** Display colors for the host palette (mirrors SDK MURAL_COLORS). */
export const MURAL_HEX: Record<string, string> = {
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#ffc53d',
  green: '#30a46c',
  teal: '#12a594',
  blue: '#0090ff',
  purple: '#8e4ec6',
  pink: '#d6409f',
  white: '#ffffff',
  black: '#1c2024',
};
const LETTERS = ['!a', '!b', '!c', '!d'];

function node(tag: 'div' | 'p' | 'span' | 'ul' | 'li' | 'ol', className: string, text?: string) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function slots(d: ExperienceDefinition): number {
  const f = d.format;
  return f?.kind === 'composition' ? f.stages.length : f?.kind === 'quiz' ? f.questions.length : 1;
}
/** Remaining time at `now`, frozen while paused or finished. */
function remainingAt(s: SessionSnapshot, now: number) {
  return s.phase === 'running' && s.deadlineAt !== null
    ? Math.max(0, s.deadlineAt - Math.max(now, s.updatedAt))
    : s.remainingMs;
}
/** The open slot, its elapsed time and whether a quiz question is in its reveal window. */
export function formatSlot(d: ExperienceDefinition, s: SessionSnapshot, now: number) {
  const n = slots(d),
    w = Math.floor(d.durationMs / n);
  const elapsed = d.durationMs - remainingAt(s, now);
  const slot = s.phase === 'finished' ? n - 1 : Math.min(n - 1, Math.floor(elapsed / w));
  const inSlot = elapsed - slot * w;
  const f = d.format;
  const reveal = f?.kind === 'quiz' && (s.phase === 'finished' || inSlot >= w - f.revealMs);
  return { slot, count: n, slotMs: w, inSlot, reveal };
}
/** Option counts for one slot from the stored choices. */
export function formatTally(d: ExperienceDefinition, s: SessionSnapshot, slot: number): number[] {
  const f = d.format;
  const options =
    f?.kind === 'composition'
      ? (f.stages[slot]?.options.length ?? 0)
      : f?.kind === 'quiz'
        ? (f.questions[slot]?.options.length ?? 0)
        : 0;
  const tally = Array.from({ length: options }, () => 0);
  for (const row of Object.values(s.format?.choices ?? {})) {
    const choice = row[slot] ?? -1;
    if (choice >= 0 && choice < options) tally[choice] = (tally[choice] ?? 0) + 1;
  }
  return tally;
}
/** Most votes; ties and empty stages go to the first listed option (declared tie-break). */
export function firstListedWinner(tally: number[]): number {
  let best = 0;
  for (let i = 1; i < tally.length; i++) if ((tally[i] ?? 0) > (tally[best] ?? 0)) best = i;
  return best;
}
function percentCorrect(tally: number[], answer: number) {
  const total = tally.reduce((a, b) => a + b, 0);
  return total ? Math.round(((tally[answer] ?? 0) * 100) / total) : 0;
}
function solved(d: ExperienceDefinition, s: SessionSnapshot, slot: number) {
  const f = d.format;
  if (f?.kind !== 'quiz') return false;
  const q = f.questions[slot];
  if (!q) return false;
  const tally = formatTally(d, s, slot);
  const total = tally.reduce((a, b) => a + b, 0);
  return total > 0 && (tally[q.answer] ?? 0) * 100 >= f.passPercent * total;
}

/** Plain-language rules sentence for the format. */
export function formatRules(d: ExperienceDefinition, language: SessionLanguage): string {
  const f = d.format;
  const t = (
    key: Parameters<typeof sessionText>[1],
    values: Record<string, string | number> = {},
  ) => sessionText(language, key, values);
  if (!f) return '';
  const command = d.contribution.command;
  if (f.kind === 'mural')
    return [
      t('muralRule', {
        command,
        example: `${command} b3 ${f.palette[0] ?? ''}`,
        colors: f.palette.join(', '),
      }),
      f.overwrite ? '' : t('muralFinalRule'),
    ]
      .filter(Boolean)
      .join(' ');
  if (f.kind === 'composition') return t('stageRule', { command });
  const options = Math.max(...f.questions.map((q) => q.options.length));
  return t('quizRule', { commands: LETTERS.slice(0, options).join(' '), percent: f.passPercent });
}

/** Append the format's live presentation to a HUD. */
export function appendFormat(
  hud: HTMLElement,
  d: ExperienceDefinition,
  s: SessionSnapshot,
  now: number,
  language: SessionLanguage,
): void {
  const f = d.format;
  const state = s.format;
  if (!f || !state) return;
  const t = (
    key: Parameters<typeof sessionText>[1],
    values: Record<string, string | number> = {},
    count?: number,
  ) => sessionText(language, key, values, count);
  const box = node('div', `session-format session-format-${f.kind}`);
  if (f.kind === 'mural') {
    const cells = f.width * f.height;
    const painted = state.canvas.filter((cell) => cell >= 0).length;
    const hidden = f.reveal === 'end' && s.phase !== 'finished';
    if (hidden)
      box.append(node('p', 'session-format-status', t('muralHidden', { painted, cells })));
    else {
      const grid = node('div', 'session-mural');
      // One accessible summary instead of up to 256 announced cells.
      grid.setAttribute('role', 'img');
      grid.setAttribute(
        'aria-label',
        t('muralCanvas', { width: f.width, height: f.height, painted, cells }),
      );
      grid.style.gridTemplateColumns = `repeat(${f.width}, 1fr)`;
      for (const cell of state.canvas) {
        const pixel = node('span', 'session-mural-cell');
        const color = cell >= 0 ? f.palette[cell] : undefined;
        if (color) pixel.style.background = MURAL_HEX[color] ?? 'transparent';
        else pixel.dataset.empty = 'true';
        grid.append(pixel);
      }
      box.append(grid);
      if (s.phase === 'finished')
        box.append(node('p', 'session-format-status', t('muralReveal', { painted, cells })));
    }
  } else {
    const { slot, count, slotMs, inSlot, reveal } = formatSlot(d, s, now);
    if (f.kind === 'composition') {
      const stage = f.stages[slot];
      if (stage && s.phase !== 'finished') {
        box.append(
          node(
            'p',
            'session-format-status',
            t('stageStatus', { stage: slot + 1, stages: count, label: stage.label }),
          ),
        );
        const tally = formatTally(d, s, slot);
        const list = node('ol', 'session-format-options');
        stage.options.forEach((option, i) =>
          list.append(
            node(
              'li',
              'session-format-option',
              t(
                'stageOption',
                { number: i + 1, label: option.label, votes: tally[i] ?? 0 },
                tally[i] ?? 0,
              ),
            ),
          ),
        );
        box.append(list);
      }
      // The composition so far: closed stages show their result, the open one is voting.
      const card = node('ul', 'session-composition');
      card.setAttribute('aria-label', t('compositionTitle'));
      card.append(node('li', 'session-composition-title', t('compositionTitle')));
      f.stages.forEach((st, i) => {
        const closed = s.phase === 'finished' || i < slot;
        const option = st.options[firstListedWinner(formatTally(d, s, i))];
        card.append(
          node(
            'li',
            closed ? 'session-composition-part' : 'session-composition-part session-pending',
            closed
              ? t('compositionPart', { stage: st.label, option: option?.label ?? '' })
              : t('compositionPending', { stage: st.label }),
          ),
        );
      });
      box.append(card);
    } else {
      const q = f.questions[slot];
      if (q) {
        box.append(
          node(
            'p',
            'session-format-status',
            t('questionStatus', { question: slot + 1, questions: count }),
          ),
          node('p', 'session-quiz-prompt', q.prompt),
        );
        const tally = formatTally(d, s, slot);
        const list = node('ol', 'session-format-options');
        q.options.forEach((option, i) => {
          const item = node(
            'li',
            'session-format-option',
            t('answerOption', { command: LETTERS[i] ?? '', label: option, count: tally[i] ?? 0 }),
          );
          if (reveal && i === q.answer) item.dataset.correct = 'true';
          list.append(item);
        });
        box.append(list);
        if (reveal) {
          const percent = percentCorrect(tally, q.answer);
          const result = node('div', 'session-quiz-reveal');
          result.setAttribute('role', 'status');
          result.append(
            node(
              'p',
              'session-quiz-answer',
              t('revealAnswer', {
                command: LETTERS[q.answer] ?? '',
                label: q.options[q.answer] ?? '',
              }),
            ),
            node(
              'p',
              'session-quiz-result',
              t(solved(d, s, slot) ? 'revealSolved' : 'revealMissed', { percent }),
            ),
            node('p', 'session-quiz-explanation', q.explanation),
          );
          box.append(result);
        } else if (s.phase !== 'finished')
          box.append(
            node(
              'p',
              'session-format-status',
              t('answersClose', {
                time: sessionSeconds(language, slotMs - f.revealMs - inSlot),
              }),
            ),
          );
        let total = 0;
        for (let i = 0; i < f.questions.length; i++) if (solved(d, s, i)) total++;
        box.append(
          node(
            'p',
            'session-quiz-summary',
            t('quizSummary', { solved: total, questions: f.questions.length }),
          ),
        );
      }
    }
  }
  hud.append(box);
}

/** Viewer-specific reasons a format command would be refused right now. */
export function formatViewerReasons(
  d: ExperienceDefinition,
  s: SessionSnapshot,
  viewerId: string,
  now: number,
  language: SessionLanguage,
): string[] {
  const f = d.format;
  if (!f || f.kind === 'mural' || s.phase !== 'running') return [];
  const { slot, reveal } = formatSlot(d, s, now);
  const reasons: string[] = [];
  if (reveal) reasons.push(sessionText(language, 'ANSWER_CLOSED'));
  const row = Object.hasOwn(s.format?.choices ?? {}, viewerId)
    ? s.format?.choices[viewerId]
    : undefined;
  if ((row?.[slot] ?? -1) >= 0) reasons.push(sessionText(language, 'ALREADY_CHOSEN'));
  return reasons;
}

/** Outcome line once the session has finished. */
export function formatOutcome(
  d: ExperienceDefinition,
  s: SessionSnapshot,
  language: SessionLanguage,
): string | null {
  const f = d.format;
  if (!f || s.phase !== 'finished') return null;
  if (f.kind === 'mural') {
    const painted = s.format?.canvas.filter((cell) => cell >= 0).length ?? 0;
    return sessionText(language, 'muralReveal', { painted, cells: f.width * f.height });
  }
  if (f.kind === 'composition')
    return f.stages
      .map((st, i) =>
        sessionText(language, 'compositionPart', {
          stage: st.label,
          option: st.options[firstListedWinner(formatTally(d, s, i))]?.label ?? '',
        }),
      )
      .join(' · ');
  let total = 0;
  for (let i = 0; i < f.questions.length; i++) if (solved(d, s, i)) total++;
  return sessionText(language, 'quizSummary', { solved: total, questions: f.questions.length });
}

/** Short scoreboard lines; compact views rotate them. */
export function formatLines(
  d: ExperienceDefinition,
  s: SessionSnapshot,
  now: number,
  language: SessionLanguage,
): string[] {
  const f = d.format;
  if (!f) return [];
  if (f.kind === 'mural')
    return [
      sessionText(language, 'linePainted', {
        painted: s.format?.canvas.filter((cell) => cell >= 0).length ?? 0,
        cells: f.width * f.height,
      }),
    ];
  const { slot, count } = formatSlot(d, s, now);
  return [
    f.kind === 'composition'
      ? sessionText(language, 'lineStage', { stage: slot + 1, stages: count })
      : sessionText(language, 'lineQuestion', { question: slot + 1, questions: count }),
  ];
}
