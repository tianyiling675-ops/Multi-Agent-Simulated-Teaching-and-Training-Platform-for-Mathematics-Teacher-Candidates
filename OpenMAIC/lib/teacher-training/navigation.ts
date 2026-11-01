export type TrainingTab = 'preparation' | 'class' | 'records';
export type TrainingLocation =
  | { view: 'home' }
  | { view: 'new' }
  | { view: 'project'; projectId: string; tab: TrainingTab; sessionId?: string };

const validId = (value: string | null): value is string =>
  !!value && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

export function parseTrainingLocation(search: string): TrainingLocation {
  const params = new URLSearchParams(search);
  const projectId = params.get('project');
  if (validId(projectId)) {
    const selected = params.get('tab');
    const tab = selected === 'class' || selected === 'records' ? selected : 'preparation';
    const sessionId = params.get('session');
    return {
      view: 'project',
      projectId,
      tab,
      ...(tab === 'records' && validId(sessionId) ? { sessionId } : {}),
    };
  }
  return { view: params.get('view') === 'new' ? 'new' : 'home' };
}

export function trainingHref(location: TrainingLocation): string {
  const params = new URLSearchParams();
  if (location.view === 'new') params.set('view', 'new');
  if (location.view === 'project') {
    params.set('project', location.projectId);
    params.set('tab', location.tab);
    if (location.tab === 'records' && location.sessionId) params.set('session', location.sessionId);
  }
  const search = params.toString();
  return `/teacher-training${search ? `?${search}` : ''}`;
}
