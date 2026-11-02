import { createHash } from 'node:crypto';
import { and, asc, count, eq, lt } from 'drizzle-orm';
import type { ParticipationLanguage } from '@riff/sdk';
import type { DatabaseConnection } from '../../db/client.js';
import { viewerPreferences } from '../../db/schema.js';

/** F20 limits and retention for explicit viewer language choices. */
export const VIEWER_LANGUAGE = {
  /** Rows per channel; the least recently updated choice is evicted beyond this. */
  maxRows: 5000,
  /** Choices nobody re-confirmed for this long are deleted. */
  retentionMs: 90 * 24 * 60 * 60 * 1000,
  /** One `!riff language` per viewer in this window (accepted or not). */
  perViewerMs: 10_000,
  /** Accepted language commands per channel per minute. */
  perChannelPerMinute: 30,
  /** Viewer-directed chat replies per channel per minute (inside the host reply budget). */
  repliesPerMinute: 4,
  /** Language counts below this are shown as "fewer than 3", never exactly. */
  minimumGroup: 3,
} as const;

export const VIEWER_LANGUAGES = ['en', 'fr', 'es', 'de'] as const satisfies ParticipationLanguage[];

const NNBSP = ' ';
/** Reviewed, whole-sentence viewer-directed copy. Never interpolates viewer text. */
export const VIEWER_COPY: Record<
  ParticipationLanguage,
  {
    name: string;
    saved: string;
    cleared: string;
    supported: string;
    disabled: string;
    nothing: string;
  }
> = {
  en: {
    name: 'English',
    saved: 'Your language is now English. Type !riff language off to clear it.',
    cleared: 'Your language choice was deleted. You will see the channel language.',
    supported: 'Choose a language: !riff language en, fr, es, de or off.',
    disabled: 'This channel shows everything in its own language.',
    nothing: 'Nothing to join right now. Watch for the next round.',
  },
  fr: {
    name: 'français',
    saved: `Votre langue est maintenant le français. Tapez !riff language off pour l’effacer.`,
    cleared: 'Votre choix de langue a été supprimé. Vous verrez la langue de la chaîne.',
    supported: `Choisissez une langue${NNBSP}: !riff language en, fr, es, de ou off.`,
    disabled: 'Cette chaîne affiche tout dans sa propre langue.',
    nothing: `Rien à rejoindre pour l’instant. Restez pour la prochaine manche.`,
  },
  es: {
    name: 'español',
    saved: 'Tu idioma ahora es el español. Escribe !riff language off para borrarlo.',
    cleared: 'Se borró tu elección de idioma. Verás el idioma del canal.',
    supported: 'Elige un idioma: !riff language en, fr, es, de u off.',
    disabled: 'Este canal muestra todo en su propio idioma.',
    nothing: 'No hay nada a lo que unirse ahora. Atento a la próxima ronda.',
  },
  de: {
    name: 'Deutsch',
    saved: 'Deine Sprache ist jetzt Deutsch. Tippe !riff language off, um sie zu löschen.',
    cleared: 'Deine Sprachwahl wurde gelöscht. Du siehst die Sprache des Kanals.',
    supported: 'Wähle eine Sprache: !riff language en, fr, es, de oder off.',
    disabled: 'Dieser Kanal zeigt alles in seiner eigenen Sprache.',
    nothing: 'Gerade gibt es nichts zum Mitmachen. Warte auf die nächste Runde.',
  },
};

/**
 * `!riff language <en|fr|es|de|off>` or `!riff lang …`. Returns null for other text,
 * `{choice: undefined}` when the argument is missing or unsupported. The raw argument is
 * never stored or echoed.
 */
export function parseLanguageCommand(
  text: string,
): { choice: ParticipationLanguage | 'off' | undefined } | null {
  const match = /^!riff\s+(?:language|lang)(?:\s+(\S{1,16}))?$/i.exec(text.trim());
  if (!match) return null;
  const arg = match[1]?.toLowerCase();
  return {
    choice:
      arg === 'off' || (VIEWER_LANGUAGES as readonly string[]).includes(arg ?? '')
        ? (arg as ParticipationLanguage | 'off')
        : undefined,
  };
}

/** Channel-salted pseudonymous key for an EventSub chatter user id. */
export const viewerKey = (channelId: string, viewerId: string) =>
  createHash('sha256')
    .update(channelId + ':' + viewerId)
    .digest('hex');

export interface LanguageCounts {
  /** Exact counts of 3 or more; `null` means 1–2 viewers (suppressed); 0 means none. */
  languages: { language: ParticipationLanguage; count: number | null }[];
  total: number | null;
}

/** Durable per-viewer language choices for one channel (table `viewer_preferences`). */
export function createViewerLanguageStore(deps: {
  database: DatabaseConnection;
  channelId: string;
  now: () => number;
}) {
  const { database, channelId, now } = deps;
  const { db } = database;
  const scope = eq(viewerPreferences.channelId, channelId);
  const suppress = (n: number) => (n > 0 && n < VIEWER_LANGUAGE.minimumGroup ? null : n);
  const store = {
    get(viewerId: string): ParticipationLanguage | null {
      const row = db
        .select({ language: viewerPreferences.language, updatedAt: viewerPreferences.updatedAt })
        .from(viewerPreferences)
        .where(and(scope, eq(viewerPreferences.viewerKey, viewerKey(channelId, viewerId))))
        .get();
      if (!row || row.updatedAt <= now() - VIEWER_LANGUAGE.retentionMs) return null;
      return row.language;
    },
    set(viewerId: string, language: ParticipationLanguage | null) {
      const key = viewerKey(channelId, viewerId),
        at = now();
      database.client.transaction(() => {
        if (language === null) {
          db.delete(viewerPreferences)
            .where(and(scope, eq(viewerPreferences.viewerKey, key)))
            .run();
          return;
        }
        db.insert(viewerPreferences)
          .values({ channelId, viewerKey: key, language, updatedAt: at })
          .onConflictDoUpdate({
            target: [viewerPreferences.channelId, viewerPreferences.viewerKey],
            set: { language, updatedAt: at },
          })
          .run();
        store.purge();
        const rows = db.select({ n: count() }).from(viewerPreferences).where(scope).get()?.n ?? 0;
        if (rows > VIEWER_LANGUAGE.maxRows) {
          const oldest = db
            .select({ key: viewerPreferences.viewerKey })
            .from(viewerPreferences)
            .where(scope)
            .orderBy(asc(viewerPreferences.updatedAt))
            .limit(rows - VIEWER_LANGUAGE.maxRows)
            .all();
          for (const row of oldest)
            db.delete(viewerPreferences)
              .where(and(scope, eq(viewerPreferences.viewerKey, row.key)))
              .run();
        }
      })();
    },
    /** Deletes choices older than the retention window. */
    purge() {
      db.delete(viewerPreferences)
        .where(and(scope, lt(viewerPreferences.updatedAt, now() - VIEWER_LANGUAGE.retentionMs)))
        .run();
    },
    clear() {
      db.delete(viewerPreferences).where(scope).run();
    },
    counts(): LanguageCounts {
      store.purge();
      const rows = db
        .select({ language: viewerPreferences.language, n: count() })
        .from(viewerPreferences)
        .where(scope)
        .groupBy(viewerPreferences.language)
        .all();
      const by = new Map(rows.map((r) => [r.language, r.n]));
      return {
        languages: VIEWER_LANGUAGES.map((language) => ({
          language,
          count: suppress(by.get(language) ?? 0),
        })),
        total: suppress(rows.reduce((sum, r) => sum + r.n, 0)),
      };
    },
  };
  return store;
}
export type ViewerLanguageStore = ReturnType<typeof createViewerLanguageStore>;
