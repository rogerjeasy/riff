import './participation.css';
import { useEffect, useRef, useState } from 'react';
import { request } from '../lib/api.js';
import { guidanceSchema, preferencesSchema, languages, type Guidance } from './contracts.js';

const key = 'riff-participation-preferences';
type Copy = Record<
  | 'title'
  | 'lead'
  | 'language'
  | 'motion'
  | 'contrast'
  | 'running'
  | 'paused'
  | 'finished'
  | 'free'
  | 'restricted'
  | 'remaining'
  | 'empty'
  | 'emptyHint'
  | 'stopped'
  | 'help'
  | 'helpHint'
  | 'loading'
  | 'lost'
  | 'device'
  | 'type'
  | 'copy'
  | 'copied'
  | 'scores'
  | 'goal'
  | 'join',
  string
>;
const copy: Record<'en' | 'fr' | 'es' | 'de', Copy> = {
  en: {
    title: 'Join the live experience',
    lead: 'Play from chat — free, no account or extension needed.',
    language: 'Language',
    motion: 'Reduce motion',
    contrast: 'High contrast',
    running: 'Live now',
    paused: 'Paused',
    finished: 'Finished',
    free: 'Free chat participation',
    restricted: 'Restricted audience — see the rules',
    remaining: 'left',
    empty: 'Nothing to play right now.',
    emptyHint: 'Keep this page open — it updates by itself when the creator starts something.',
    stopped: 'The creator has paused all participation.',
    help: 'Just arrived?',
    helpHint: 'Type this in chat to show the instructions on stream:',
    loading: 'Loading current instructions…',
    lost: 'Connection lost. Retrying for the current rules…',
    device: 'Display options on this device only. The creator controls the stream itself.',
    type: 'Type in chat',
    copy: 'Copy',
    copied: 'Copied',
    scores: 'Scores',
    goal: 'Goal progress',
    join: 'Join a team',
  },
  fr: {
    title: 'Participer au direct',
    lead: 'Jouez depuis le chat — gratuit, sans compte ni extension.',
    language: 'Langue',
    motion: 'Réduire les animations',
    contrast: 'Contraste élevé',
    running: 'En direct',
    paused: 'En pause',
    finished: 'Terminé',
    free: 'Participation gratuite dans le chat',
    restricted: 'Public restreint — voir les règles',
    remaining: 'restantes',
    empty: 'Rien à jouer pour le moment.',
    emptyHint:
      'Gardez cette page ouverte : elle se met à jour dès que le créateur lance quelque chose.',
    stopped: 'Le créateur a mis toute participation en pause.',
    help: 'Vous arrivez ?',
    helpHint: 'Tapez ceci dans le chat pour afficher les instructions à l’écran :',
    loading: 'Chargement des instructions…',
    lost: 'Connexion perdue. Nouvelle tentative…',
    device: 'Options d’affichage pour cet appareil uniquement. Le créateur contrôle le stream.',
    type: 'Tapez dans le chat',
    copy: 'Copier',
    copied: 'Copié',
    scores: 'Scores',
    goal: 'Progression de l’objectif',
    join: 'Rejoindre une équipe',
  },
  es: {
    title: 'Participa en el directo',
    lead: 'Juega desde el chat: gratis, sin cuenta ni extensión.',
    language: 'Idioma',
    motion: 'Reducir movimiento',
    contrast: 'Alto contraste',
    running: 'En directo',
    paused: 'En pausa',
    finished: 'Terminado',
    free: 'Participación gratuita por chat',
    restricted: 'Público restringido: consulta las reglas',
    remaining: 'restantes',
    empty: 'No hay nada para jugar ahora.',
    emptyHint: 'Deja esta página abierta: se actualiza sola cuando el creador empiece algo.',
    stopped: 'El creador ha pausado toda la participación.',
    help: '¿Acabas de llegar?',
    helpHint: 'Escribe esto en el chat para mostrar las instrucciones en el directo:',
    loading: 'Cargando instrucciones…',
    lost: 'Conexión perdida. Reintentando…',
    device: 'Opciones de visualización solo para este dispositivo. El creador controla el directo.',
    type: 'Escribe en el chat',
    copy: 'Copiar',
    copied: 'Copiado',
    scores: 'Puntuaciones',
    goal: 'Progreso del objetivo',
    join: 'Únete a un equipo',
  },
  de: {
    title: 'Am Livestream teilnehmen',
    lead: 'Spiel über den Chat mit – kostenlos, ohne Konto oder Erweiterung.',
    language: 'Sprache',
    motion: 'Bewegung reduzieren',
    contrast: 'Hoher Kontrast',
    running: 'Jetzt live',
    paused: 'Pausiert',
    finished: 'Beendet',
    free: 'Kostenlose Chat-Teilnahme',
    restricted: 'Eingeschränkte Teilnahme – siehe Regeln',
    remaining: 'übrig',
    empty: 'Gerade läuft nichts zum Mitspielen.',
    emptyHint: 'Lass diese Seite offen – sie aktualisiert sich, sobald der Streamer etwas startet.',
    stopped: 'Der Streamer hat die Teilnahme pausiert.',
    help: 'Gerade dazugekommen?',
    helpHint: 'Schreib das in den Chat, um die Anleitung im Stream anzuzeigen:',
    loading: 'Aktuelle Anleitung wird geladen…',
    lost: 'Verbindung verloren. Neuer Versuch…',
    device: 'Anzeigeoptionen nur für dieses Gerät. Der Streamer steuert den Stream selbst.',
    type: 'In den Chat schreiben',
    copy: 'Kopieren',
    copied: 'Kopiert',
    scores: 'Punkte',
    goal: 'Zielfortschritt',
    join: 'Einem Team beitreten',
  },
};

function initial() {
  try {
    const p = preferencesSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? 'null'));
    if (p.success) return p.data;
  } catch {
    /* Storage may be disabled. */
  }
  const browser = typeof navigator === 'undefined' ? '' : navigator.language.slice(0, 2);
  return {
    language: (['en', 'fr', 'es', 'de'] as const).find((l) => l === browser) ?? ('en' as const),
    reducedMotion:
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    highContrast: false,
  };
}
const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** Copyable chat command: the single most important thing on this page. */
function Command({ text, c }: { text: string; c: Copy }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="participation-command">
      <code>{text}</code>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
        aria-label={`${c.copy} ${text}`}
      >
        {copied ? c.copied : c.copy}
      </button>
    </span>
  );
}

export function ParticipationPage() {
  const [preferences, setPreferences] = useState(initial);
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const received = useRef(Date.now());
  const c = copy[preferences.language];
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(preferences));
    } catch {
      /* In-memory preferences still work. */
    }
  }, [preferences]);
  useEffect(() => {
    const old = document.documentElement.lang;
    const title = document.title;
    document.documentElement.lang = preferences.language;
    document.title = `${copy[preferences.language].title} · Riff`;
    return () => {
      document.documentElement.lang = old;
      document.title = title;
    };
  }, [preferences.language]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = guidanceSchema.parse(
          await request(
            'GET',
            `/participation?language=${preferences.language}`,
            undefined,
            controller.signal,
          ),
        );
        if (!controller.signal.aborted) {
          received.current = Date.now();
          setGuidance(next);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [preferences.language]);
  // Count down locally between polls so the timer moves every second.
  const ticking = guidance?.interactions.some(
    (i) => i.phase === 'running' && i.remainingMs !== null,
  );
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const elapsed = Math.max(0, now - received.current);

  return (
    <main
      className="participation-page"
      data-high-contrast={preferences.highContrast || guidance?.highContrast || undefined}
      data-reduced-motion={preferences.reducedMotion || guidance?.reducedMotion || undefined}
    >
      <header className="participation-hero">
        <p className="participation-brand" aria-hidden="true">
          riff<span>.</span>
        </p>
        <h1>{c.title}</h1>
        <p className="participation-lead">{c.lead}</p>
      </header>

      <section className="participation-options" aria-label={c.device}>
        <label className="participation-language">
          <span id="participation-language-label">{c.language}</span>
          <select
            aria-labelledby="participation-language-label"
            value={preferences.language}
            onChange={(e) =>
              setPreferences({
                ...preferences,
                language: preferencesSchema.shape.language.parse(e.target.value),
              })
            }
          >
            {languages.map(([value, label]) => (
              <option key={value} value={value} lang={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="participation-switch">
          <input
            type="checkbox"
            role="switch"
            checked={preferences.reducedMotion}
            onChange={(e) => setPreferences({ ...preferences, reducedMotion: e.target.checked })}
          />
          <span>{c.motion}</span>
        </label>
        <label className="participation-switch">
          <input
            type="checkbox"
            role="switch"
            checked={preferences.highContrast}
            onChange={(e) => setPreferences({ ...preferences, highContrast: e.target.checked })}
          />
          <span>{c.contrast}</span>
        </label>
        <p>{c.device}</p>
      </section>

      {error && (
        <p role="alert" className="participation-notice" data-tone="warn">
          {c.lost}
        </p>
      )}
      {!guidance ? (
        !error && (
          <p role="status" className="participation-notice">
            {c.loading}
          </p>
        )
      ) : guidance.stopped ? (
        <p role="status" className="participation-empty">
          {c.stopped}
        </p>
      ) : !guidance.interactions.length ? (
        <div className="participation-empty">
          <p>
            <b>{c.empty}</b>
          </p>
          <p>{c.emptyHint}</p>
        </div>
      ) : (
        <div className="participation-list">
          {guidance.interactions.map((item) => {
            const remaining =
              item.remainingMs === null
                ? null
                : item.phase === 'running'
                  ? Math.max(0, item.remainingMs - elapsed)
                  : item.remainingMs;
            const top = Math.max(1, ...item.scores.map((s) => s.score));
            return (
              <section
                className="participation-experience"
                key={item.id}
                aria-labelledby={`participation-${item.id}`}
                data-phase={item.phase}
              >
                <div className="participation-experience-head">
                  <h2 id={`participation-${item.id}`}>{item.title}</h2>
                  <span className="participation-phase" data-phase={item.phase}>
                    {c[item.phase]}
                  </span>
                </div>
                {item.command && (
                  <div className="participation-type">
                    <span>{c.type}</span>
                    <Command text={item.command} c={c} />
                  </div>
                )}
                {item.joinCommands && item.joinCommands.length > 0 && (
                  <div className="participation-type">
                    <span>{c.join}</span>
                    {item.joinCommands.map((join) => (
                      <Command key={join} text={join} c={c} />
                    ))}
                  </div>
                )}
                <p className="participation-objective">{item.objective}</p>
                <ul className="participation-rules">
                  {item.instructions.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                <div className="participation-meta">
                  <span data-free={item.free}>{item.free ? c.free : c.restricted}</span>
                  {remaining !== null && (
                    <span className="participation-clock">
                      <b>{clock(remaining)}</b> {c.remaining}
                    </span>
                  )}
                </div>
                {item.goal && item.goal.target > 0 && (
                  <div className="participation-goal">
                    <span>
                      {c.goal}: <b>{item.goal.current}</b> / {item.goal.target}
                    </span>
                    <div
                      role="progressbar"
                      aria-label={c.goal}
                      aria-valuemin={0}
                      aria-valuemax={item.goal.target}
                      aria-valuenow={Math.min(item.goal.current, item.goal.target)}
                    >
                      <span
                        style={{
                          width: `${Math.min(100, (item.goal.current / item.goal.target) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
                {item.scores.length > 0 && (
                  <dl className="participation-scores" aria-label={c.scores}>
                    {item.scores.map((score, i) => (
                      <div key={i}>
                        <dt>{score.label}</dt>
                        <dd>
                          <span
                            className="participation-bar"
                            style={{ width: `${(score.score / top) * 100}%` }}
                            aria-hidden="true"
                          />
                          <b>{score.score}</b>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {item.outcome && (
                  <p role="status" className="participation-outcome">
                    {item.outcome}
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}
      {guidance && !guidance.stopped && (
        <aside className="participation-help">
          <b>{c.help}</b>
          <span>{c.helpHint}</span>
          <Command text={guidance.helpCommand} c={c} />
        </aside>
      )}
    </main>
  );
}
