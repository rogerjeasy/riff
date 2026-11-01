import type {
  AudienceRole,
  DecisionCode,
  PermissionManifest,
  Scenario,
  SessionAssertion,
} from '@riff/sdk';

/*
 * Independent host acceptance suite for definition version 2. Every expectation below is
 * computed by hand from the canonical definition (never by running the engine), so a
 * generated handler or a host regression cannot make its own evidence pass. Scenarios
 * that would need more synthetic input than the bounds below are skipped, not reduced.
 */
const MAX_SUITE_STEPS = 60;

type Step = Scenario['steps'][number];

export function mechanicsHostScenarios(manifest: PermissionManifest): Scenario[] {
  const d = manifest.experience;
  const m = d?.mechanics;
  if (!d || !m) return [];
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
    id = `m${++seq}`,
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
  const command = d.contribution.command;
  const teamA = d.teams[0],
    teamB = d.teams[1],
    teamC = d.teams[2];
  const keyA = teamA?.id ?? 'community',
    keyB = teamB?.id;
  const P = d.contribution.points,
    R = d.resource.perParticipant;
  const health = m.health,
    burst = m.burst,
    match = m.match;
  const hitsToEliminate = health ? Math.ceil(health.max / health.damage) : Infinity;
  const target = d.objective.target ?? Infinity;
  const countingBurst = burst?.command === null ? burst : null;
  /** True when `n` contributions by `viewers` distinct side-A viewers could end round one. */
  const endsEarly = (n: number, viewers = 1) =>
    hitsToEliminate <= n ||
    (d.objective.kind === 'collective-goal' && n * P >= target) ||
    (countingBurst !== null &&
      viewers >= countingBurst.participants &&
      (d.objective.kind === 'burst' || countingBurst.points > 0 || countingBurst.shieldMs > 0));
  const join = (viewer: string, team = teamA, at = 0): Step[] =>
    team ? [step(viewer, team.joinCommand, at, 'ACCEPTED')] : [];
  const nextRound = (assertion: SessionAssertion = {}): SessionAssertion =>
    match ? { ...assertion, phase: 'running', round: 2 } : { ...assertion, phase: 'finished' };
  const suite: Scenario[] = [];
  const push = (scenario: Scenario) => {
    if (scenario.steps.length <= MAX_SUITE_STEPS) suite.push(scenario);
  };

  // 1. One contribution: ledger, score and (with health) damage to every other team.
  const firstEnds = endsEarly(1);
  const afterFirst: SessionAssertion = firstEnds
    ? nextRound(match ? {} : { winner: hitsToEliminate <= 1 ? keyA : 'community' })
    : {
        phase: 'running',
        round: 1,
        scores: { [keyA]: P },
        participants: { ada: { remaining: R - 1, contributions: 1 } },
        ...(health && keyB
          ? { standings: { [keyB]: { health: health.max - health.damage, eliminated: false } } }
          : {}),
      };
  push({
    name: 'Version 2 contribution updates score, resources and pools from the definition',
    kind: 'happy',
    steps: [...join('ada'), step('ada', command, 1, 'ACCEPTED', afterFirst, 'first')],
  });
  push({
    name: 'Version 2 duplicate identity cannot act twice',
    kind: 'duplicate',
    steps: [
      ...join('ada'),
      step('ada', command, 1, 'ACCEPTED', afterFirst, 'first'),
      step('ada', command, 2, 'DUPLICATE', afterFirst, 'first'),
    ],
  });
  push({
    name: 'Version 2 unrelated chat changes nothing',
    kind: 'negative',
    steps: [
      ...join('ada'),
      step('ada', 'hello chat', 1, 'UNRELATED', { scores: { [keyA]: 0 }, round: 1 }),
    ],
  });
  if (teamA)
    push({
      name: 'Version 2 requires joining and keeps the chosen team',
      kind: 'role',
      steps: [
        step('ada', command, 0, 'NOT_JOINED'),
        ...join('ada'),
        step('ada', teamB?.joinCommand ?? teamA.joinCommand, 1, 'ALREADY_JOINED'),
      ],
    });

  // 2. The round deadline: finish, or open the next round's intermission.
  const deadlineWinner = d.teams.length ? 'tie' : null;
  push({
    name: match
      ? 'The round deadline starts the next round and restores resources'
      : 'The session finishes before acting at the exact deadline',
    kind: 'limit',
    steps: [
      ...join('ada'),
      step(
        'ada',
        command,
        d.durationMs,
        match ? (match.intermissionMs > 0 ? 'ROUND_INTERMISSION' : 'ACCEPTED') : 'SESSION_FINISHED',
        match
          ? {
              phase: 'running',
              round: 2,
              ...(match.intermissionMs > 0
                ? {
                    remainingMs: d.durationMs + match.intermissionMs,
                    participants: { ada: { remaining: R, contributions: 0 } },
                  }
                : {}),
            }
          : { phase: 'finished', remainingMs: 0, winner: deadlineWinner, scores: { [keyA]: 0 } },
      ),
    ],
  });

  // 3. Lifetime resources inside a round.
  if (!endsEarly(R) && R <= 40) {
    const steps = join('ada');
    for (let i = 0; i < R; i++)
      steps.push(
        step('ada', command, 1 + i, 'ACCEPTED', {
          scores: { [keyA]: (i + 1) * P },
          participants: { ada: { remaining: R - i - 1, contributions: i + 1 } },
        }),
      );
    steps.push(step('ada', command, 1 + R, 'RESOURCE_LIMIT'));
    push({ name: 'Version 2 resources never renew inside a round', kind: 'limit', steps });
  }

  // 4. Distinct-participant burst over a sliding host-clocked window.
  if (burst && burst.participants <= 20) {
    const N = burst.participants;
    const text = burst.command ?? command;
    const viewers = Array.from({ length: N }, (_, i) => `b${i}`);
    const repeat = burst.command !== null || R >= 2;
    const contributions = burst.command === null ? N + (repeat ? 1 : 0) : 0;
    const healthSafe = !health || hitsToEliminate > contributions;
    const goalSafe = !(
      d.objective.kind === 'collective-goal' && contributions * P + burst.points >= target
    );
    if (healthSafe && goalSafe) {
      const steps: Step[] = [];
      if (health && teamB) steps.push(...join('enemy', teamB));
      for (const viewer of viewers) steps.push(...join(viewer));
      let at = 10;
      for (const [i, viewer] of viewers.slice(0, -1).entries())
        steps.push(
          step(viewer, text, at + i, 'ACCEPTED', { standings: { [keyA]: { bursts: 0 } } }),
        );
      at += N;
      if (repeat)
        steps.push(
          step('b0', text, at++, burst.command ? 'BURST_COUNTED' : 'ACCEPTED', {
            standings: { [keyA]: { bursts: 0 } },
          }),
        );
      const triggerAt = at++;
      const wins = d.objective.kind === 'burst' && target <= 1;
      const score = contributions * P + burst.points;
      steps.push(
        step(
          viewers[N - 1] ?? 'b0',
          text,
          triggerAt,
          'ACCEPTED',
          wins
            ? nextRound(match ? {} : { winner: keyA, scores: { [keyA]: score } })
            : { standings: { [keyA]: { bursts: 1 } }, scores: { [keyA]: score } },
        ),
      );
      if (!wins && burst.shieldMs > 0 && health && teamB) {
        steps.push(
          step('enemy', command, at++, 'ACCEPTED', {
            standings: { [keyA]: { health: health.max } },
          }),
        );
        if (burst.command)
          steps.push(
            step('b0', burst.command, at++, burst.limit <= 1 ? 'BURST_LIMIT' : 'BURST_ACTIVE'),
          );
        const expires = triggerAt + burst.shieldMs;
        if (expires < d.durationMs && health.damage < health.max && R >= 2)
          steps.push(
            step('enemy', command, expires, 'ACCEPTED', {
              standings: { [keyA]: { health: health.max - health.damage } },
            }),
          );
      }
      push({
        name: `${burst.label} needs ${N} different viewers within ${burst.windowMs} ms`,
        kind: 'happy',
        steps,
      });
    }
    // Sliding window expiry: the first viewer ages out before the last arrives.
    const expiry = 1 + burst.windowMs;
    if (
      expiry < d.durationMs &&
      (!health || hitsToEliminate > (burst.command ? 0 : N)) &&
      !(d.objective.kind === 'collective-goal' && burst.command === null && N * P >= target)
    ) {
      const steps: Step[] = [];
      for (const viewer of viewers) steps.push(...join(viewer));
      for (const [i, viewer] of viewers.slice(0, -1).entries())
        steps.push(step(viewer, text, 1 + i, 'ACCEPTED'));
      steps.push(
        step(viewers[N - 1] ?? 'b0', text, expiry, 'ACCEPTED', {
          standings: { [keyA]: { bursts: 0 } },
        }),
      );
      push({
        name: `${burst.label} window slides: actions older than ${burst.windowMs} ms stop counting`,
        kind: 'window',
        steps,
      });
    }
  }

  // 5. Health pools: damage, heal, elimination.
  if (health && teamA && teamB && hitsToEliminate <= 40) {
    const steps: Step[] = [...join('foe', teamB)];
    const threeTeams = Boolean(teamC) && hitsToEliminate >= 2;
    const fromA = threeTeams ? hitsToEliminate - 1 : hitsToEliminate;
    const viewersNeeded = Math.ceil(fromA / R);
    const burstEnds =
      countingBurst !== null &&
      d.objective.kind === 'burst' &&
      viewersNeeded >= countingBurst.participants;
    if (!burstEnds && viewersNeeded + 2 <= d.maxParticipants) {
      let at = 1;
      for (let hit = 0; hit < fromA; hit++) {
        const viewer = `a${Math.floor(hit / R)}`;
        if (hit % R === 0) steps.push(...join(viewer, teamA, at++));
        const remainingHealth = Math.max(0, health.max - (hit + 1) * health.damage);
        const last = hit === fromA - 1 && !threeTeams;
        steps.push(
          step(
            viewer,
            command,
            at++,
            'ACCEPTED',
            last
              ? nextRound(match ? { wins: { [teamA.id]: 1 } } : { winner: teamA.id })
              : { standings: { [teamB.id]: { health: remainingHealth, eliminated: false } } },
          ),
        );
      }
      if (threeTeams && teamC) {
        steps.push(...join('cee', teamC, at++));
        steps.push(
          step('cee', command, at++, 'ACCEPTED', {
            phase: 'running',
            standings: {
              [teamB.id]: { health: 0, eliminated: true },
              [teamA.id]: { health: health.max - health.damage, eliminated: false },
            },
          }),
        );
        steps.push(step('foe', command, at++, 'ELIMINATED'));
      } else
        steps.push(
          step(
            'foe',
            command,
            at++,
            match
              ? match.intermissionMs > 0
                ? 'ROUND_INTERMISSION'
                : 'ACCEPTED'
              : 'SESSION_FINISHED',
          ),
        );
      push({
        name: threeTeams
          ? `A team at 0 ${health.label} is eliminated and its players are rejected`
          : `Reducing the last opposing team to 0 ${health.label} ends the round`,
        kind: 'limit',
        steps,
      });
    }
    if (health.heal && !endsEarly(1)) {
      const healed = Math.min(health.max, health.max - health.damage + health.heal.amount);
      push({
        name: `${health.heal.command} restores ${health.label} but never above the maximum`,
        kind: 'limit',
        steps: [
          ...join('foe', teamB),
          step('foe', health.heal.command, 1, 'HEALTH_FULL', {
            participants: { foe: { remaining: R } },
          }),
          ...join('ada', teamA, 2),
          step('ada', command, 3, 'ACCEPTED'),
          step('foe', health.heal.command, 4, 'ACCEPTED', {
            standings: { [teamB.id]: { health: healed } },
            participants: { foe: { remaining: R - 1 } },
          }),
        ],
      });
    }
  }

  // 6. Best-of-N match progression with per-round reset.
  if (match && !endsEarly(1)) {
    const T = d.durationMs,
      I = match.intermissionMs;
    const r1Winner = d.teams.length ? keyA : null;
    const steps: Step[] = [
      ...join('ada'),
      step('ada', command, 1, 'ACCEPTED', { round: 1, scores: { [keyA]: P } }),
      step('ada', command, T, I > 0 ? 'ROUND_INTERMISSION' : 'ACCEPTED', {
        phase: 'running',
        round: 2,
        wins: { [keyA]: r1Winner ? 1 : 0 },
        ...(I > 0 ? { scores: { [keyA]: 0 }, participants: { ada: { remaining: R } } } : {}),
      }),
    ];
    if (I > 0)
      steps.push(
        step('ada', command, T + I, 'ACCEPTED', {
          round: 2,
          participants: { ada: { remaining: R - 1, contributions: 1 } },
        }),
      );
    steps.push(
      step('ada', 'hello chat', match.rounds * (T + I), 'UNRELATED', {
        phase: 'finished',
        winner: r1Winner,
      }),
    );
    push({
      name: `Best of ${match.rounds}: rounds reset resources and a majority ends the match`,
      kind: 'limit',
      steps,
    });
  }

  // 7. Milestones unlock tiers and commands at exact score thresholds.
  const milestone = m.milestones.find((x) => x.unlock) ?? m.milestones[0];
  if (milestone) {
    const k = Math.ceil(milestone.score / P);
    const viewersUsed = Math.ceil((k + 1) / R);
    const after = k * P + (milestone.unlock?.points ?? 0);
    const tier = (score: number) => m.milestones.filter((x) => score >= x.score).length;
    if (
      k <= 40 &&
      viewersUsed + 1 <= d.maxParticipants &&
      !endsEarly(k + 1, viewersUsed) &&
      !(d.objective.kind === 'collective-goal' && after >= target)
    ) {
      const steps: Step[] = [...join('u0')];
      if (milestone.unlock) steps.push(step('u0', milestone.unlock.command, 1, 'LOCKED'));
      let at = 2;
      for (let i = 0; i < k; i++) {
        const viewer = `u${Math.floor(i / R)}`;
        if (i > 0 && i % R === 0) steps.push(...join(viewer, teamA, at++));
        steps.push(
          step(viewer, command, at++, 'ACCEPTED', {
            standings: { [keyA]: { tier: tier((i + 1) * P) } },
          }),
        );
      }
      if (milestone.unlock) {
        const spender = `u${Math.floor(k / R)}`;
        if (k % R === 0) steps.push(...join(spender, teamA, at++));
        steps.push(
          step(spender, milestone.unlock.command, at++, 'ACCEPTED', {
            scores: { [keyA]: after },
            standings: { [keyA]: { tier: tier(after) } },
          }),
        );
      }
      push({
        name: `${milestone.label} unlocks at ${milestone.score} points${milestone.unlock ? ` and enables ${milestone.unlock.command}` : ''}`,
        kind: 'limit',
        steps,
      });
    }
  }

  if (!manifest.trigger.audience.includes('viewer')) {
    const denied = step('ben', teamA?.joinCommand ?? command, 0, 'AUDIENCE');
    denied.roles = ['viewer'];
    push({
      name: 'Version 2 joins and actions enforce the declared audience',
      kind: 'role',
      steps: [denied],
    });
  }
  return suite;
}
