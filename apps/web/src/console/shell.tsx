import './shell.css';
import { useEffect, useState, type ReactNode } from 'react';

export interface ShellSection {
  id: string;
  label: string;
  /** One short glyph shown in the navigation; decorative only. */
  icon: string;
  hint?: string | undefined;
}

/**
 * The console's section navigation: a fixed rail on wide screens and a sticky, scrollable
 * strip on tablets and phones. It only scrolls; every section stays mounted, so live
 * state, sockets and in-progress work never reset when the creator moves around.
 */
export function SectionNav({ sections }: { sections: ShellSection[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');
  useEffect(() => {
    const onScroll = () => {
      // The last section whose top has passed the upper third of the viewport is current.
      const line = window.innerHeight * 0.3;
      let current = sections[0]?.id ?? '';
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= line) current = section.id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [sections]);
  return (
    <nav className="section-nav" aria-label="Studio sections">
      <ul>
        {sections.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              aria-current={active === section.id ? 'location' : undefined}
              onClick={(event) => {
                const target = document.getElementById(section.id);
                if (!target) return;
                event.preventDefault();
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                history.replaceState(null, '', `#${section.id}`);
                setActive(section.id);
              }}
            >
              <span className="section-nav-icon" aria-hidden="true">
                {section.icon}
              </span>
              <span className="section-nav-label">{section.label}</span>
              {section.hint && <span className="section-nav-hint">{section.hint}</span>}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A titled region of the console. */
export function StudioSection({
  id,
  eyebrow,
  title,
  lead,
  aside,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lead?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="studio-section" aria-labelledby={`${id}-title`}>
      <header className="studio-section-head">
        <div>
          <p className="studio-eyebrow">{eyebrow}</p>
          <h2 id={`${id}-title`}>{title}</h2>
          {lead && <p className="studio-section-lead">{lead}</p>}
        </div>
        {aside}
      </header>
      <div className="studio-section-body">{children}</div>
    </section>
  );
}
