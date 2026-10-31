import type { ProposalService } from './service.js';
import type { ChannelRepository } from '../../db/repositories/studio.js';
export type ApplicationStatus =
  'selected' | 'queued' | 'generating' | 'candidate' | 'applied' | 'failed';
export type CommunityProjection = Omit<
  ReturnType<ProposalService['publicProjection']>,
  'selections'
> & {
  selections: (Omit<
    ReturnType<ProposalService['publicProjection']>['selections'][number],
    'status'
  > & { status: ApplicationStatus })[];
};
/** Always start with current domain eligibility and credit; durable links add status only. */
export function communityProjection(
  proposals: ProposalService,
  repo: ChannelRepository,
): CommunityProjection {
  const projection = proposals.publicProjection();
  const appliedVersions = repo.appliedVersionLineage();
  return {
    ...projection,
    selections: projection.selections.map((selection) => {
      const link = repo.generationForSelection(selection.id);
      const run = link ? repo.run(link.runId) : undefined;
      const version = run?.versionId ? repo.version(run.versionId) : undefined;
      const status: ApplicationStatus =
        version && appliedVersions.has(version.id)
          ? 'applied'
          : version?.status === 'candidate'
            ? 'candidate'
            : run?.status === 'queued'
              ? 'queued'
              : run &&
                  !['ready', 'failed', 'cancelled', 'question', 'unsupported'].includes(run.status)
                ? 'generating'
                : run
                  ? 'failed'
                  : 'selected';
      return { ...selection, status };
    }),
  };
}
