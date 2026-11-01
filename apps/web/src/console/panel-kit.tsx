import './panel-kit.css';
import { useId, useState, type ReactNode } from 'react';

export type Tone = 'good' | 'warn' | 'bad' | 'live' | 'muted' | 'private';

/**
 * A collapsible console card. Collapsed, it is one line: title, purpose and a status pill,
 * so optional studio tools never push the describe → test → approve flow off screen.
 */
export function PanelCard({
  title,
  subtitle,
  status,
  actions,
  defaultOpen = false,
  className = '',
  children,
}: {
  title: string;
  subtitle: string;
  status: { text: string; tone: Tone };
  /** Always-visible controls (for example an immediate stop) shown beside the status. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className={`card panel-card ${className}`} aria-label={title}>
      <header className="panel-head">
        <button
          type="button"
          className="panel-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="panel-chevron" aria-hidden="true" />
          <span className="panel-title">{title}</span>
          <span className="panel-subtitle">{subtitle}</span>
        </button>
        <div className="panel-head-side">
          {actions}
          <span className={`pill ${status.tone}`}>{status.text}</span>
        </div>
      </header>
      <div id={bodyId} className="panel-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/** A numbered step whose marker turns into a check once done. */
export function Step({
  title,
  done = false,
  current = false,
  aside,
  children,
}: {
  title: string;
  done?: boolean;
  current?: boolean;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li
      className="panel-step"
      data-done={done || undefined}
      aria-current={current ? 'step' : undefined}
    >
      <div className="panel-step-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </li>
  );
}

export function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <div className="panel-stat" data-tone={tone}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {hint && <dd className="panel-stat-hint">{hint}</dd>}
    </div>
  );
}

/** A pass/fail line used for proofs and checks. */
export function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="panel-check" data-ok={ok}>
      <span aria-hidden="true">{ok ? '✓' : '✕'}</span>
      <span>
        <span className="sr-only">{ok ? 'Passed: ' : 'Failed: '}</span>
        {children}
      </span>
    </li>
  );
}

/** Short, copyable fingerprint of a SHA-256 digest; the full value stays in the title. */
export function Fingerprint({ value, label = 'Fingerprint' }: { value: string; label?: string }) {
  return (
    <code className="panel-fingerprint" title={`${label}: ${value}`}>
      {value.slice(0, 12)}
    </code>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  /** null when no option is currently selected. */
  value: T | null;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented panel-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          title={option.hint}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** WAI-ARIA tabs with roving focus (arrow keys, Home, End). Panels stay mounted only when active. */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  children,
}: {
  label: string;
  tabs: readonly { value: T; label: string; badge?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  const base = useId();
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.value === value),
  );
  const focus = (next: number) => {
    const tab = tabs[(next + tabs.length) % tabs.length];
    if (!tab) return;
    onChange(tab.value);
    document.getElementById(`${base}-tab-${tab.value}`)?.focus();
  };
  return (
    <div className="panel-tabs">
      <div
        role="tablist"
        aria-label={label}
        className="panel-tablist"
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') focus(index + 1);
          else if (e.key === 'ArrowLeft') focus(index - 1);
          else if (e.key === 'Home') focus(0);
          else if (e.key === 'End') focus(tabs.length - 1);
          else return;
          e.preventDefault();
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.value}
            id={`${base}-tab-${tab.value}`}
            type="button"
            role="tab"
            aria-selected={tab.value === value}
            aria-controls={`${base}-panel`}
            tabIndex={tab.value === value ? 0 : -1}
            onClick={() => onChange(tab.value)}
          >
            {tab.label}
            {tab.badge}
          </button>
        ))}
      </div>
      <div
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${value}`}
        className="panel-tabpanel"
      >
        {children}
      </div>
    </div>
  );
}
