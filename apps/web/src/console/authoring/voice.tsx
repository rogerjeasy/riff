import './voice.css';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError } from '../../lib/api.js';

/**
 * F09 push-to-talk. Hold the button (pointer or Space/Enter) to record, or tap/activate
 * it once to start and again to stop. The transcript lands in an editable review field
 * and is never submitted on its own; typing always remains available.
 */
const statusSchema = z.object({
  voice: z.object({
    provider: z.enum(['openai', 'mock', 'none']),
    maxDurationMs: z.number().int().positive().max(300_000),
    maxBytes: z.number().int().positive(),
    mimeTypes: z.array(z.string()).max(10),
  }),
});
const transcriptSchema = z.object({
  transcript: z.object({ text: z.string().min(1).max(1200), provider: z.string() }),
});
const CANDIDATE_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
];
/** Holding longer than this is push-to-talk; a shorter press toggles recording. */
const HOLD_MS = 350;
const MIN_RECORDING_MS = 400;

type Engine = 'server' | 'browser';
type Failure = 'denied' | 'no-device' | 'unsupported' | 'too-short' | 'no-speech' | 'failed';
type Phase =
  | { kind: 'checking' }
  | { kind: 'unavailable'; reason: 'not-configured' | 'unsupported' }
  | { kind: 'ready' }
  | { kind: 'requesting' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'transcribing' }
  | { kind: 'review'; text: string }
  | { kind: 'error'; failure: Failure; message: string; retry: boolean };

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechCtor = new () => SpeechRecognitionLike;
function speechRecognition(): SpeechCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechCtor;
    webkitSpeechRecognition?: SpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
function canRecord() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.MediaRecorder === 'function'
  );
}
function pickMimeType() {
  const recorder = window.MediaRecorder as typeof MediaRecorder & {
    isTypeSupported?: (type: string) => boolean;
  };
  return CANDIDATE_TYPES.find((type) => recorder.isTypeSupported?.(type)) ?? '';
}
const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
function mediaFailure(error: unknown): { failure: Failure; message: string } {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return {
      failure: 'denied',
      message:
        'Microphone access is blocked. Allow the microphone in your browser’s site settings, then retry — or type instead.',
    };
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError')
    return {
      failure: 'no-device',
      message:
        name === 'NotReadableError'
          ? 'Your microphone is in use by another app. Close it and retry, or type instead.'
          : 'No microphone was found. Connect one and retry, or type instead.',
    };
  return { failure: 'failed', message: 'Recording could not start. Retry, or type instead.' };
}

export function VoiceInput({
  disabled,
  onUse,
}: {
  disabled: boolean;
  onUse: (text: string, mode: 'replace' | 'append') => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [engine, setEngine] = useState<Engine | null>(null);
  const [provider, setProvider] = useState<'openai' | 'mock' | null>(null);
  const [maxMs, setMaxMs] = useState(60_000);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const reviewId = useId();
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const speech = useRef<SpeechRecognitionLike | null>(null);
  const speechText = useRef('');
  const chunks = useRef<Blob[]>([]);
  const lastRecording = useRef<{ blob: Blob; durationMs: number } | null>(null);
  const audio = useRef<{ context: AudioContext; frame: number } | null>(null);
  const pressedAt = useRef<number | null>(null);
  const upload = useRef<AbortController | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const reviewField = useRef<HTMLTextAreaElement | null>(null);
  const reviewing = phase.kind === 'review';
  useEffect(() => {
    if (reviewing) reviewField.current?.focus({ preventScroll: true });
  }, [reviewing]);

  useEffect(() => {
    const controller = new AbortController();
    const fallback = () => {
      if (speechRecognition()) {
        setEngine('browser');
        setPhase({ kind: 'ready' });
      } else setPhase({ kind: 'unavailable', reason: 'not-configured' });
    };
    fetch('/api/voice', { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('status'))))
      .then((body: unknown) => {
        const { voice } = statusSchema.parse(body);
        setMaxMs(voice.maxDurationMs);
        if (voice.provider === 'none') return fallback();
        if (canRecord()) {
          setEngine('server');
          setProvider(voice.provider);
          setPhase({ kind: 'ready' });
        } else if (speechRecognition()) {
          setEngine('browser');
          setPhase({ kind: 'ready' });
        } else setPhase({ kind: 'unavailable', reason: 'unsupported' });
      })
      .catch(() => {
        if (!controller.signal.aborted) fallback();
      });
    return () => controller.abort();
  }, []);

  const releaseMedia = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (audio.current) {
      cancelAnimationFrame(audio.current.frame);
      void audio.current.context.close().catch(() => undefined);
      audio.current = null;
    }
    setLevel(0);
  }, []);
  useEffect(
    () => () => {
      upload.current?.abort();
      speech.current?.abort();
      if (recorder.current?.state === 'recording') recorder.current.stop();
      releaseMedia();
    },
    [releaseMedia],
  );

  const transcribe = useCallback(async (blob: Blob, durationMs: number) => {
    setPhase({ kind: 'transcribing' });
    upload.current?.abort();
    const controller = new AbortController();
    upload.current = controller;
    try {
      const response = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'audio/webm',
          'x-riff-request': '1',
          'x-riff-audio-duration-ms': String(Math.round(durationMs)),
        },
        body: blob,
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = z.object({ message: z.string().max(400) }).safeParse(body);
        throw new ApiError(
          message.success ? message.data.message : 'Transcription failed. Retry, or type instead.',
          response.status,
          null,
        );
      }
      const { transcript } = transcriptSchema.parse(body);
      setPhase({ kind: 'review', text: transcript.text });
    } catch (error) {
      if (controller.signal.aborted) return;
      setPhase({
        kind: 'error',
        failure: 'failed',
        message:
          error instanceof ApiError
            ? error.message
            : 'Riff’s server could not be reached for transcription. Retry, or type instead.',
        // A provider that is not configured will not start working on retry.
        retry: !(error instanceof ApiError && error.status === 503),
      });
    }
  }, []);

  const meter = useCallback((media: MediaStream) => {
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    try {
      const context = new Context();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(media).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) sum += ((value - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
        if (audio.current) audio.current.frame = requestAnimationFrame(tick);
      };
      audio.current = { context, frame: requestAnimationFrame(tick) };
    } catch {
      /* The meter is a convenience; recording continues without it. */
    }
  }, []);

  const start = useCallback(async () => {
    const current = phaseRef.current.kind;
    if (
      disabled ||
      !engine ||
      current === 'recording' ||
      current === 'requesting' ||
      current === 'transcribing'
    )
      return;
    lastRecording.current = null;
    setElapsed(0);
    if (engine === 'browser') {
      const Ctor = speechRecognition();
      if (!Ctor) return setPhase({ kind: 'unavailable', reason: 'unsupported' });
      const recognition = new Ctor();
      recognition.lang = document.documentElement.lang || navigator.language || 'en-US';
      recognition.continuous = true;
      recognition.interimResults = false;
      speechText.current = '';
      recognition.onresult = (event) => {
        speechText.current = Array.from(event.results)
          .map((result) => result[0]?.transcript ?? '')
          .join(' ');
      };
      recognition.onerror = (event) => {
        if (speech.current !== recognition) return;
        const failure: Failure =
          event.error === 'not-allowed' || event.error === 'service-not-allowed'
            ? 'denied'
            : event.error === 'audio-capture'
              ? 'no-device'
              : event.error === 'no-speech'
                ? 'no-speech'
                : 'failed';
        speech.current = null;
        setPhase({
          kind: 'error',
          failure,
          retry: true,
          message:
            failure === 'denied'
              ? mediaFailure({ name: 'NotAllowedError' }).message
              : failure === 'no-device'
                ? mediaFailure({ name: 'NotFoundError' }).message
                : failure === 'no-speech'
                  ? 'No speech was detected. Speak closer to the microphone and retry.'
                  : 'Your browser’s speech service failed. Retry, or type instead.',
        });
      };
      recognition.onend = () => {
        if (speech.current !== recognition) return;
        speech.current = null;
        const text = speechText.current.replace(/\s+/g, ' ').trim().slice(0, 1200);
        setPhase(
          text
            ? { kind: 'review', text }
            : {
                kind: 'error',
                failure: 'no-speech',
                retry: true,
                message: 'No speech was detected. Speak closer to the microphone and retry.',
              },
        );
      };
      speech.current = recognition;
      try {
        recognition.start();
        setPhase({ kind: 'recording', startedAt: Date.now() });
      } catch {
        speech.current = null;
        setPhase({
          kind: 'error',
          failure: 'failed',
          retry: true,
          message: 'Your browser’s speech service failed. Retry, or type instead.',
        });
      }
      return;
    }
    setPhase({ kind: 'requesting' });
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      return setPhase({ kind: 'error', retry: true, ...mediaFailure(error) });
    }
    stream.current = media;
    let instance: MediaRecorder;
    try {
      const mimeType = pickMimeType();
      instance = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
    } catch {
      releaseMedia();
      return setPhase({
        kind: 'error',
        failure: 'unsupported',
        retry: false,
        message: 'This browser cannot record audio in a supported format. Type instead.',
      });
    }
    chunks.current = [];
    const startedAt = Date.now();
    instance.ondataavailable = (event) => {
      if (event.data.size) chunks.current.push(event.data);
    };
    instance.onstop = () => {
      releaseMedia();
      recorder.current = null;
      const durationMs = Math.min(maxMs, Date.now() - startedAt);
      const blob = new Blob(chunks.current, {
        type: instance.mimeType || chunks.current[0]?.type || 'audio/webm',
      });
      chunks.current = [];
      if (phaseRef.current.kind !== 'recording') return; // discarded
      if (durationMs < MIN_RECORDING_MS || blob.size === 0)
        return setPhase({
          kind: 'error',
          failure: 'too-short',
          retry: false,
          message:
            'That was too short. Hold the button while you speak, or tap once to start and again to stop.',
        });
      lastRecording.current = { blob, durationMs };
      void transcribe(blob, durationMs);
    };
    recorder.current = instance;
    instance.start(250);
    meter(media);
    setPhase({ kind: 'recording', startedAt });
  }, [disabled, engine, maxMs, meter, releaseMedia, transcribe]);

  const stop = useCallback(() => {
    if (phaseRef.current.kind !== 'recording') return;
    if (speech.current) speech.current.stop();
    else if (recorder.current?.state === 'recording') recorder.current.stop();
  }, []);
  const discard = useCallback(() => {
    upload.current?.abort();
    lastRecording.current = null;
    if (speech.current) {
      const recognition = speech.current;
      speech.current = null;
      recognition.abort();
    }
    // Update the ref synchronously so a pending recorder `stop` event sees the discard.
    phaseRef.current = { kind: 'ready' };
    setPhase({ kind: 'ready' });
    if (recorder.current?.state === 'recording') recorder.current.stop();
    releaseMedia();
  }, [releaseMedia]);

  // Elapsed time and the hard duration cap.
  useEffect(() => {
    if (phase.kind !== 'recording') return;
    const startedAt = phase.startedAt;
    const timer = setInterval(() => {
      const ms = Date.now() - startedAt;
      setElapsed(ms);
      if (ms >= maxMs) stop();
    }, 200);
    return () => clearInterval(timer);
  }, [phase, maxMs, stop]);

  const press = () => {
    if (phaseRef.current.kind === 'recording') {
      pressedAt.current = null;
      stop();
      return;
    }
    pressedAt.current = Date.now();
    void start();
  };
  const release = () => {
    const at = pressedAt.current;
    pressedAt.current = null;
    if (at !== null && Date.now() - at >= HOLD_MS) stop();
  };

  if (phase.kind === 'checking') return null;
  const recording = phase.kind === 'recording';
  const busy = phase.kind === 'requesting' || phase.kind === 'transcribing';
  const unavailable = phase.kind === 'unavailable';
  const announce =
    phase.kind === 'requesting'
      ? 'Waiting for microphone permission…'
      : recording
        ? `Recording · ${clock(elapsed)} of ${clock(maxMs)}. Release or press again to stop.`
        : phase.kind === 'transcribing'
          ? 'Transcribing your recording…'
          : phase.kind === 'review'
            ? 'Transcript ready. Review and edit it before using it.'
            : '';

  return (
    <div className="voice" data-state={phase.kind}>
      {unavailable ? (
        <p className="voice-unavailable" role="note">
          {phase.reason === 'not-configured'
            ? 'Voice unavailable — type instead. Set OPENAI_API_KEY on the server to enable push-to-talk.'
            : 'Voice unavailable in this browser — type instead.'}
        </p>
      ) : (
        <div className="voice-row">
          <button
            type="button"
            className="button small voice-talk"
            aria-pressed={recording}
            aria-describedby={`${reviewId}-hint`}
            disabled={disabled || busy || phase.kind === 'review'}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture?.(e.pointerId);
              press();
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && recording) {
                e.preventDefault();
                discard();
                return;
              }
              if (e.key !== ' ' && e.key !== 'Enter') return;
              e.preventDefault();
              if (!e.repeat) press();
            }}
            onKeyUp={(e) => {
              if (e.key !== ' ' && e.key !== 'Enter') return;
              e.preventDefault();
              release();
            }}
            onClick={(e) => {
              // Pointer and key presses are handled above; assistive technology
              // dispatches a bare click (detail 0) which toggles recording.
              if (e.detail !== 0 || pressedAt.current !== null) return;
              press();
              pressedAt.current = null; // a click is a complete tap: toggle, not hold
            }}
          >
            <span className="voice-dot" aria-hidden="true" />
            {recording
              ? 'Stop recording'
              : phase.kind === 'requesting'
                ? 'Allow microphone…'
                : 'Hold to talk'}
          </button>
          {recording && (
            <>
              <span
                className="voice-meter"
                role="meter"
                aria-label="Microphone level"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(level * 100)}
              >
                <span
                  style={{ transform: `scaleX(${engine === 'browser' ? 1 : level})` }}
                  data-static={engine === 'browser' || undefined}
                />
              </span>
              <span className="voice-time mono" aria-hidden="true">
                {clock(elapsed)} / {clock(maxMs)}
              </span>
              <button type="button" className="button small ghost" onClick={discard}>
                Discard
              </button>
            </>
          )}
          {phase.kind === 'transcribing' && (
            <>
              <span className="voice-spinner" aria-hidden="true" />
              <span className="voice-time">Transcribing…</span>
              <button type="button" className="button small ghost" onClick={discard}>
                Cancel
              </button>
            </>
          )}
          <span id={`${reviewId}-hint`} className="voice-hint">
            {engine === 'browser'
              ? 'Uses your browser’s speech recognition, which may send audio to the browser vendor.'
              : provider === 'mock'
                ? 'Offline mock transcription (deterministic). Audio is never stored.'
                : 'Audio goes to Riff’s server for OpenAI transcription and is never stored.'}{' '}
            Hold Space or the button, or tap once to start and again to stop. Esc discards.
          </span>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
      {phase.kind === 'error' && (
        <div className="voice-error answer bad" role="alert">
          <p>{phase.message}</p>
          <div className="voice-actions">
            {phase.retry && (
              <button
                type="button"
                className="button small"
                onClick={() => {
                  const last = lastRecording.current;
                  if (last) void transcribe(last.blob, last.durationMs);
                  else setPhase({ kind: 'ready' });
                }}
              >
                {lastRecording.current ? 'Retry transcription' : 'Try again'}
              </button>
            )}
            <button
              type="button"
              className="button small ghost"
              onClick={() => {
                lastRecording.current = null;
                setPhase({ kind: 'ready' });
                document.getElementById('intent')?.focus();
              }}
            >
              Type instead
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'review' && (
        <div className="voice-review">
          <label htmlFor={reviewId}>Review transcript — edit anything before using it</label>
          <textarea
            id={reviewId}
            rows={3}
            maxLength={1200}
            value={phase.text}
            onChange={(e) => setPhase({ kind: 'review', text: e.target.value })}
            ref={reviewField}
          />
          <div className="voice-actions">
            <button
              type="button"
              className="button small primary"
              disabled={!phase.text.trim()}
              onClick={() => {
                lastRecording.current = null;
                onUse(phase.text.trim(), 'replace');
                setPhase({ kind: 'ready' });
              }}
            >
              Use as description
            </button>
            <button
              type="button"
              className="button small"
              disabled={!phase.text.trim()}
              onClick={() => {
                lastRecording.current = null;
                onUse(phase.text.trim(), 'append');
                setPhase({ kind: 'ready' });
              }}
            >
              Add to description
            </button>
            <button type="button" className="button small ghost" onClick={discard}>
              Discard
            </button>
          </div>
          <p className="voice-hint">Nothing is generated until you press Generate.</p>
        </div>
      )}
    </div>
  );
}
