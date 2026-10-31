export class StudioError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'STALE' | 'BLOCKED',
    message: string,
  ) {
    super(message);
  }
}
