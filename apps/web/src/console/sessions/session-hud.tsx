import { useEffect, useRef, useState } from 'react';
import type { ExperienceDefinition, SessionSnapshot } from '../../lib/types.js';
import { createSessionHud } from '../../sessions/presentation.js';

/** Console owns its own clock; preview passes a deterministic synthetic timestamp. */
export function SessionHud(props: {
  definition: ExperienceDefinition;
  snapshot: SessionSnapshot;
  now?: number;
  viewerId?: string;
  label?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (props.now !== undefined || props.snapshot.phase !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [props.now, props.snapshot.phase]);
  useEffect(() => {
    root.current?.replaceChildren(
      createSessionHud(props.definition, props.snapshot, {
        now: props.now ?? now,
        ...(props.viewerId ? { viewerId: props.viewerId } : {}),
        ...(props.label ? { label: props.label } : {}),
      }),
    );
  }, [props.definition, props.snapshot, props.now, props.viewerId, props.label, now]);
  return <div ref={root} className="session-preview" />;
}
