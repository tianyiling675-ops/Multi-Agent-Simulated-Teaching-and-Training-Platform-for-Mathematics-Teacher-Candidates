import type { SessionStatus, TrainingProject, TrainingState } from './contracts';

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  grade: string;
  round: number;
  status: SessionStatus;
  materialNumber: number;
  template: 'strong' | 'mixed' | 'support';
  plannedMinutes: number;
  lastActivityAt: string;
}
export interface ProjectSummary extends TrainingProject {
  versionCount: number;
  sessionCount: number;
  materialNumber: number | null;
  draftChanged: boolean;
  latestSession: SessionSummary | null;
}
export interface TrainingOverview {
  projects: ProjectSummary[];
  recentSessions: SessionSummary[];
  resumeSession: SessionSummary | null;
}
export const emptyOverview = (): TrainingOverview => ({
  projects: [],
  recentSessions: [],
  resumeSession: null,
});

/** Project only metadata, once per owner read; never return embedded materials or profiles. */
export function projectOverview(state: TrainingState): TrainingOverview {
  const versions = new Map<string, { count: number; latest: number }>();
  for (const material of Object.values(state.materials)) {
    const entry = versions.get(material.projectId) ?? { count: 0, latest: 0 };
    entry.count++;
    entry.latest = Math.max(entry.latest, material.number);
    versions.set(material.projectId, entry);
  }
  const byProject = new Map<string, SessionSummary[]>();
  const sessions = Object.values(state.sessions).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  for (const session of sessions) {
    const project = state.projects[session.projectId];
    const material = state.materials[session.materialVersionId];
    const config = state.classes[session.classConfigVersionId];
    if (!project || !material || !config) continue;
    const group = byProject.get(project.id) ?? [];
    const events = state.events[session.id] ?? [];
    group.push({
      id: session.id,
      projectId: project.id,
      title: project.title,
      grade: project.grade,
      round: group.length + 1,
      status: session.status,
      materialNumber: material.number,
      template: config.template,
      plannedMinutes: session.trainingConfig.plannedMinutes,
      lastActivityAt: events.at(-1)?.receivedAt ?? session.endedAt ?? session.createdAt,
    });
    byProject.set(project.id, group);
  }
  const recent = [...byProject.values()]
    .flat()
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id));
  const projects = Object.values(state.projects)
    .map((project): ProjectSummary => {
      const version = versions.get(project.id);
      const draft = state.drafts[project.id];
      const rounds = byProject.get(project.id) ?? [];
      return {
        ...project,
        versionCount: version?.count ?? 0,
        sessionCount: rounds.length,
        materialNumber: version?.latest ?? null,
        draftChanged: !!draft && draft.revision !== (draft.lastConfirmedRevision ?? 0),
        latestSession:
          [...rounds].sort(
            (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id.localeCompare(a.id),
          )[0] ?? null,
      };
    })
    .sort((a, b) => {
      const at = a.latestSession?.lastActivityAt;
      const bt = b.latestSession?.lastActivityAt;
      return (
        (bt && bt > b.updatedAt ? bt : b.updatedAt).localeCompare(
          at && at > a.updatedAt ? at : a.updatedAt,
        ) || a.id.localeCompare(b.id)
      );
    });
  return {
    projects,
    recentSessions: recent.slice(0, 50),
    resumeSession: recent.find((session) => session.status !== 'ended') ?? null,
  };
}
