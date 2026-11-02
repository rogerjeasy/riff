import {
  MURAL_COLORS,
  QUIZ_ANSWER_COMMANDS,
  type AudienceRole,
  type DecisionCode,
  type PermissionManifest,
  type Scenario,
  type SessionAssertion,
} from '@riff/sdk';

/*
 * Independent host acceptance suite for definition version 3 formats. Every expectation is
 * computed by hand from the canonical definition (never by running the engine), so neither
 * a generated handler nor a host regression can make its own evidence pass. Cells, options
 * and letters are spelled out here rather than produced by the host's own parsers.
 */
const MAX_SUITE_STEPS = 60;
type Step = Scenario['steps'][number];

export function formatHostScenarios(manifest: PermissionManifest): Scenario[] {
  const d = manifest.experience;
  const f = d?.format;
  if (!d || !f) return [];
  const eligible: AudienceRole[] = manifest.trigger.audience.includes('viewer')
    ? ['viewer']
    : [manifest.trigger.audience[0] ?? 'broadcaster', 'viewer'];
  let seq = 0;
  const step = (
    viewer: string,
    text: string,
    at: number,
    expect: DecisionCode,
    session?: SessionAssertion,
    id = `f${++seq}`,
  ): Step => ({
    id,
    viewer,
    text,
    at,
    roles: eligible,
    expect,
    effects: expect === 'ACCEPTED' ? -2 : 0,
    ...(session ? { session } : {}),
  });
  const P = d.contribution.points,
    R = d.resource.perParticipant,
    cmd = d.contribution.command;
  const suite: Scenario[] = [];
  const push = (scenario: Scenario) => {
    if (scenario.steps.length && scenario.steps.length <= MAX_SUITE_STEPS) suite.push(scenario);
  };
  const slots =
    f.kind === 'composition' ? f.stages.length : f.kind === 'quiz' ? f.questions.length : 1;
  const w = Math.floor(d.durationMs / slots);

  // A valid first action, spelled by hand.
  const cellName = (index: number, width: number) =>
    `${'abcdefghijklmnop'[index % width] ?? 'a'}${Math.floor(index / width) + 1}`;
  const first =
    f.kind === 'mural'
      ? `${cmd} ${cellName(0, f.width)} ${f.palette[0] ?? 'red'}`
      : f.kind === 'composition'
        ? `${cmd} ${f.stages[0]?.options[0]?.id ?? ''}`
        : '!a';

  push({
    name: 'Ordinary chat and the bare command change nothing',
    kind: 'negative',
    steps: [
      step('ann', 'hello chat', 0, 'UNRELATED'),
      ...(f.kind === 'quiz' ? [] : [step('ann', cmd, 1, 'INVALID_CHOICE')]),
      step('ann', first, 2, 'ACCEPTED', {
        scores: { community: P },
        participants: { ann: { remaining: R - 1, contributions: 1 } },
      }),
    ],
  });
  push({
    name: 'A redelivered action counts once',
    kind: 'duplicate',
    steps: [
      step('ann', first, 1, 'ACCEPTED', undefined, 'same'),
      step('ann', first, 2, 'DUPLICATE', { scores: { community: P } }, 'same'),
    ],
  });
  push({
    name: 'The exact deadline finishes the session for the whole community',
    kind: 'limit',
    steps: [
      step('ann', first, 0, 'ACCEPTED'),
      step('bob', first, d.durationMs, 'SESSION_FINISHED', {
        phase: 'finished',
        winner: 'community',
        scores: { community: P },
      }),
    ],
  });

  if (f.kind === 'mural') {
    const cells = f.width * f.height;
    const unused = (Object.keys(MURAL_COLORS) as (keyof typeof MURAL_COLORS)[]).find(
      (c) => !f.palette.includes(c),
    );
    const outside =
      f.width < 16 ? `${'abcdefghijklmnop'[f.width]}1` : f.height < 16 ? `a${f.height + 1}` : 'q1';
    push({
      name: 'Only declared cells and palette colors are accepted',
      kind: 'negative',
      steps: [
        step('ann', `${cmd} ${outside} ${f.palette[0]}`, 0, 'INVALID_CHOICE'),
        ...(unused ? [step('ann', `${cmd} a1 ${unused}`, 1, 'INVALID_CHOICE')] : []),
        step('ann', `${cmd} a1 hello world`, 2, 'INVALID_CHOICE'),
        step('ann', `${cmd} A1 ${(f.palette[1] ?? '').toUpperCase()}`, 3, 'ACCEPTED', {
          format: { painted: 1 },
          scores: { community: P },
        }),
      ],
    });
    if (R <= 30 && (f.overwrite || R < cells)) {
      const steps: Step[] = [];
      for (let i = 0; i < R; i++)
        steps.push(
          step('ann', `${cmd} ${cellName(i % cells, f.width)} ${f.palette[0]}`, i, 'ACCEPTED'),
        );
      steps.push(
        step('ann', `${cmd} ${cellName(R % cells, f.width)} ${f.palette[0]}`, R, 'RESOURCE_LIMIT', {
          participants: { ann: { remaining: 0, contributions: R } },
          format: { painted: Math.min(R, cells) },
          scores: { community: R * P },
        }),
      );
      push({ name: 'Each viewer paints at most their allowance', kind: 'limit', steps });
    }
    push({
      name: f.overwrite ? 'A later paint replaces the cell color' : 'A painted cell is final',
      kind: 'limit',
      steps: [
        step('ann', `${cmd} a1 ${f.palette[0]}`, 0, 'ACCEPTED'),
        step('bob', `${cmd} a1 ${f.palette[1]}`, 1, f.overwrite ? 'ACCEPTED' : 'CELL_TAKEN', {
          format: { painted: 1 },
          scores: { community: f.overwrite ? 2 * P : P },
        }),
      ],
    });
    if (d.maxParticipants <= 20 && d.maxParticipants < cells) {
      const steps: Step[] = [];
      for (let i = 0; i <= d.maxParticipants; i++)
        steps.push(
          step(
            `v${i}`,
            `${cmd} ${cellName(i, f.width)} ${f.palette[0]}`,
            i,
            i === d.maxParticipants ? 'PARTICIPANT_LIMIT' : 'ACCEPTED',
          ),
        );
      push({ name: 'The participant limit is enforced', kind: 'limit', steps });
    }
  }

  if (f.kind === 'composition') {
    const s0 = f.stages[0],
      s1 = f.stages[1];
    if (s0 && s1) {
      const tally0 = s0.options.map((_, i) => (i === 0 || i === 1 ? 1 : 0));
      push({
        name: 'One vote per viewer per stage, by option id or number',
        kind: 'happy',
        steps: [
          step('ann', `${cmd} ${s0.options[0]?.id}`, 0, 'ACCEPTED', {
            format: { slot: 0, tally: s0.options.map((_, i) => (i === 0 ? 1 : 0)) },
          }),
          step('ann', `${cmd} ${s0.options[1]?.id}`, 1, 'ALREADY_CHOSEN'),
          step('bob', `${cmd} 2`, 2, 'ACCEPTED', { format: { tally: tally0 } }),
          step('cat', `${cmd} 9`, 4, 'INVALID_CHOICE'),
          step('ann', `${cmd} ${s1.options[0]?.id}`, w, 'ACCEPTED', {
            format: { slot: 1, tally: s1.options.map((_, i) => (i === 0 ? 1 : 0)) },
            participants: { ann: { contributions: 2, remaining: R - 2 } },
            scores: { community: 3 * P },
          }),
        ],
      });
      const later = s1.options.find((o) => !s0.options.some((x) => x.id === o.id));
      if (later)
        push({
          name: 'A later stage cannot be voted on early',
          kind: 'negative',
          steps: [step('ann', `${cmd} ${later.id}`, 0, 'INVALID_CHOICE')],
        });
    }
  }

  if (f.kind === 'quiz') {
    const q0 = f.questions[0];
    if (q0) {
      const right = QUIZ_ANSWER_COMMANDS[q0.answer] ?? '!a';
      const wrongIndex = q0.answer === 0 ? 1 : 0;
      const wrong = QUIZ_ANSWER_COMMANDS[wrongIndex] ?? '!b';
      const tally = q0.options.map((_, i) => (i === q0.answer || i === wrongIndex ? 1 : 0));
      // One right and one wrong answer: solved exactly when 50% meets passPercent.
      const solvedHalf = 50 >= f.passPercent ? 1 : 0;
      const steps: Step[] = [
        step('ann', right, 0, 'ACCEPTED', {
          format: {
            slot: 0,
            tally: q0.options.map((_, i) => (i === q0.answer ? 1 : 0)),
            solved: 1,
          },
        }),
        step('ann', wrong, 1, 'ALREADY_CHOSEN'),
        step('bob', wrong, 2, 'ACCEPTED', { format: { tally, solved: solvedHalf } }),
      ];
      if (q0.options.length < 4)
        steps.push(step('cat', QUIZ_ANSWER_COMMANDS[3], 3, 'INVALID_CHOICE'));
      if (f.revealMs > 0)
        steps.push(
          step('cat', right, w - f.revealMs, 'ANSWER_CLOSED', {
            scores: { community: 2 * P },
          }),
        );
      if (f.questions.length > 1)
        steps.push(
          step('cat', right === '!a' ? '!b' : '!a', w, 'ACCEPTED', {
            format: { slot: 1 },
            participants: { cat: { contributions: 1 } },
          }),
        );
      push({
        name: 'Answers lock in, close for the reveal and count collectively',
        kind: 'happy',
        steps,
      });
    }
  }
  return suite;
}
