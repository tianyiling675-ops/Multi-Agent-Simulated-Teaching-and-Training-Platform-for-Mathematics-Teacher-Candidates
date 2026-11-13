export type TrainingTab = 'preparation' | 'class' | 'records';
export type PreparationSection = 'lesson' | 'slides' | 'sources';
export type TrainingLocation =
  | { view: 'home' }
  | { view: 'new' }
  | { view: 'projects' }
  | { view: 'history' }
  | {
      view: 'project';
      projectId: string;
      tab: TrainingTab;
      sessionId?: string;
      section?: PreparationSection;
      pageId?: string;
    };

const validId = (value: string | null): value is string =>
  !!value && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

export function parseTrainingLocation(search: string): TrainingLocation {
  const params = new URLSearchParams(search);
  const projectId = params.get('project');
  if (validId(projectId)) {
    const selected = params.get('tab');
    const tab = selected === 'class' || selected === 'records' ? selected : 'preparation';
    const sessionId = params.get('session');
    const section = params.get('section');
    const pageId = params.get('page');
    return {
      view: 'project',
      projectId,
      tab,
      ...(tab === 'records' && validId(sessionId) ? { sessionId } : {}),
      ...(tab === 'preparation' && (section === 'slides' || section === 'sources')
        ? { section }
        : {}),
      ...(tab === 'preparation' && validId(pageId) ? { pageId } : {}),
    };
  }
  const view = params.get('view');
  return { view: view === 'new' || view === 'projects' || view === 'history' ? view : 'home' };
}

export function trainingHref(location: TrainingLocation): string {
  const params = new URLSearchParams();
  if (location.view === 'new') params.set('view', 'new');
  if (location.view === 'projects' || location.view === 'history')
    params.set('view', location.view);
  if (location.view === 'project') {
    params.set('project', location.projectId);
    params.set('tab', location.tab);
    if (location.tab === 'records' && location.sessionId) params.set('session', location.sessionId);
    if (location.tab === 'preparation' && location.section && location.section !== 'lesson')
      params.set('section', location.section);
    if (location.tab === 'preparation' && location.pageId) params.set('page', location.pageId);
  }
  const search = params.toString();
  return `/teacher-training${search ? `?${search}` : ''}`;
}
