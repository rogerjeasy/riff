import { requirements } from './contracts.js';

const AUDIENCE: Record<string, string> = {
  viewer: 'Everyone',
  subscriber: 'Subscribers',
  moderator: 'Moderators',
  broadcaster: 'Broadcaster',
};
const duration = (ms: number) =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} seconds`;
export const audienceLabel = (roles: readonly string[]) =>
  roles.map((role) => AUDIENCE[role] ?? role).join(', ');

/** Compact facts grid for a recipe's rules and requirements. */
export function RuleFacts({ manifest }: { manifest: unknown }) {
  const rules = requirements(manifest);
  if (!rules)
    return (
      <p className="panel-callout" data-tone="warn">
        This recipe’s rules could not be read, so it cannot be installed here.
      </p>
    );
  const { experience, trigger } = rules;
  return (
    <dl className="recipe-facts">
      <div>
        <dt>Command</dt>
        <dd>
          <code>{experience?.contribution.command ?? trigger.command}</code>
          {!!experience?.teams.length && (
            <span className="panel-hint">
              {' '}
              · join with {experience.teams.map((team) => team.joinCommand).join(' / ')}
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt>Who can play</dt>
        <dd>{audienceLabel(trigger.audience)}</dd>
      </div>
      <div>
        <dt>Allowance</dt>
        <dd>
          {experience
            ? `${experience.resource.perParticipant} ${experience.resource.name} per round · ${duration(experience.durationMs)} rounds`
            : `${trigger.maxPerViewer} per viewer every ${duration(trigger.windowMs)}`}
        </dd>
      </div>
      <div>
        <dt>Needs</dt>
        <dd>
          {rules.capabilities.join(', ')} · SDK {rules.sdkVersion} · chat read only
        </dd>
      </div>
    </dl>
  );
}
