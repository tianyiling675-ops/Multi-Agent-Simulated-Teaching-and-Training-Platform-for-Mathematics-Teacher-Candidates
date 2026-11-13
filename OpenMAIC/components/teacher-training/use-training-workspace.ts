'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClassConfigDraft,
  MaterialContent,
  ProjectDetail,
  SessionDetail,
  TrainingProject,
  TrainingSession,
} from '@/lib/teacher-training/contracts';
import {
  classDraftSchema,
  emptyMaterial,
  serializeMaterial,
} from '@/lib/teacher-training/contracts';
import {
  defaultClassForm,
  normalizeClassForm,
  type ClassForm,
} from '@/lib/teacher-training/class-form';
import { emptyOverview, type TrainingOverview } from '@/lib/teacher-training/overview';
import {
  parseTrainingLocation,
  type TrainingLocation,
  type PreparationSection,
} from '@/lib/teacher-training/navigation';
import { trainingApi, classroomHref } from '@/lib/teacher-training/client';
import { useTrainingNavigation } from './use-training-navigation';

export type TrainingCapability = {
  storage: string;
  identity: string;
  phase: string;
  available: string[];
  pending: string[];
  documentConversion?: { enabled: boolean; message?: string };
};

export function useTrainingWorkspace(initialLocation: TrainingLocation) {
  const [capability, setCapability] = useState<TrainingCapability>();
  const [overview, setOverview] = useState<TrainingOverview>(emptyOverview);
  const [detail, setDetail] = useState<ProjectDetail>();
  const [content, setContent] = useState<MaterialContent>(emptyMaterial);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail>();
  const [classForm, setClassForm] = useState<ClassForm>(() => defaultClassForm(null));
  const [classDraft, setClassDraft] = useState<ClassConfigDraft | null>(null);
  const [classBaseline, setClassBaseline] = useState('');
  const [newProject, setNewProject] = useState({ title: '', grade: '', scope: '' });
  const [busy, setBusy] = useState('正在打开工作台…');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [outlineDirty, setOutlineDirty] = useState(false);
  const [preparationVisited, setPreparationVisited] = useState(false);
  const [preparationLocation, setPreparationLocation] = useState<{
    section: PreparationSection;
    pageId?: string;
  }>({
    section: initialLocation.view === 'project' ? (initialLocation.section ?? 'lesson') : 'lesson',
    ...(initialLocation.view === 'project' && initialLocation.pageId
      ? { pageId: initialLocation.pageId }
      : {}),
  });
  const actionLock = useRef(false);
  const allowLeave = useRef(false);
  const pendingOperation = useRef<{ signature: string; id: string } | null>(null);
  const dirty = !!detail && serializeMaterial(content) !== serializeMaterial(detail.draft.content);
  const classDirty = !!detail && !!classBaseline && JSON.stringify(classForm) !== classBaseline;
  const newProjectDirty = Object.values(newProject).some((value) => value.length > 0);

  const canLeave = (target: TrainingLocation) => {
    if (busy || actionLock.current) {
      setNotice('当前操作尚未完成，请稍后切换。');
      return false;
    }
    const leavesProject = target.view !== 'project' || target.projectId !== detail?.project.id;
    const losesInput =
      (leavesProject && (dirty || outlineDirty || classDirty)) ||
      (newProjectDirty && target.view !== 'new');
    return (
      !losesInput ||
      window.confirm(
        '还有未保存的教案、大纲或班级配置。确定放弃修改并离开？取消可继续编辑。已保存的课堂不会结束。',
      )
    );
  };
  const navigation = useTrainingNavigation(initialLocation, {
    canLeave,
    onNavigate: (target) => {
      void run('正在打开页面…', () => loadLocation(target));
    },
  });

  async function run(label: string, work: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await work();
      pendingOperation.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成，请保留输入后重试。');
    } finally {
      actionLock.current = false;
      setBusy('');
    }
  }
  function operationKey(input: unknown) {
    const signature = JSON.stringify(input);
    if (signature !== pendingOperation.current?.signature)
      pendingOperation.current = { signature, id: crypto.randomUUID() };
    return pendingOperation.current!.id;
  }
  const setDocumentBusy = useCallback((value: boolean) => {
    actionLock.current = value;
    setBusy(value ? '正在处理材料…' : '');
  }, []);

  async function refreshOverview(signal?: AbortSignal) {
    const next = await trainingApi<TrainingOverview>('overview', undefined, { signal });
    setOverview(next);
  }
  async function loadLocation(target: TrainingLocation, signal?: AbortSignal) {
    if (target.view !== 'project') {
      setDetail(undefined);
      setSessionDetail(undefined);
      setContent(emptyMaterial());
      setClassBaseline('');
      setClassDraft(null);
      setOutlineDirty(false);
      setNewProject({ title: '', grade: '', scope: '' });
      await refreshOverview(signal);
      return;
    }
    const sameProject = detail?.project.id === target.projectId;
    if (!sameProject) {
      setPreparationVisited(target.tab === 'preparation');
      setDetail(undefined);
      setSessionDetail(undefined);
      setOutlineDirty(false);
    }
    if (target.tab === 'records' && target.sessionId !== sessionDetail?.session.id)
      setSessionDetail(undefined);
    const [project, config, session] = await Promise.all([
      sameProject
        ? Promise.resolve(detail!)
        : trainingApi<ProjectDetail>(`projects/${target.projectId}`, undefined, { signal }),
      sameProject
        ? Promise.resolve(classDraft)
        : trainingApi<ClassConfigDraft | null>(
            `projects/${target.projectId}/class-draft`,
            undefined,
            { signal },
          ),
      target.tab === 'records' && target.sessionId
        ? trainingApi<SessionDetail>(`sessions/${target.sessionId}`, undefined, { signal })
        : Promise.resolve(undefined),
    ]);
    if (signal?.aborted) return;
    if (session && session.session.projectId !== project.project.id)
      throw new Error('课堂记录不属于此课题，请返回备课与历史重新选择。');
    if (!sameProject) {
      const selected =
        project.materials.find((version) => version.id === config?.materialVersionId)?.id ??
        project.draft.lastVersionId ??
        project.materials[0]?.id ??
        null;
      const form: ClassForm = config
        ? {
            template: config.template,
            students: config.students,
            plannedMinutes: config.plannedMinutes,
            materialVersionId: selected,
          }
        : defaultClassForm(selected);
      setDetail(project);
      setContent(project.draft.content);
      setClassDraft(config);
      setClassForm(form);
      setClassBaseline(JSON.stringify(form));
    }
    if (!sameProject || target.tab === 'preparation')
      setPreparationLocation({
        section: target.section ?? 'lesson',
        ...(target.pageId ? { pageId: target.pageId } : {}),
      });
    if (sameProject && target.tab === 'preparation') setPreparationVisited(true);
    if (session) setSessionDetail(session);
    else if (!sameProject || target.tab === 'records') setSessionDetail(undefined);
    setNewProject({ title: '', grade: '', scope: '' });
  }

  const initialLoad = useRef(loadLocation);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      // Establish the device Cookie before parallel owner-scoped requests.
      const next = await trainingApi<TrainingCapability>('capabilities', undefined, {
        signal: controller.signal,
      });
      if (!active) return;
      setCapability(next);
      const target = parseTrainingLocation(window.location.search);
      if (target.view === 'project') await refreshOverview(controller.signal);
      await initialLoad.current(target, controller.signal);
      if (active) setBusy('');
    })().catch((cause) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : '工作台暂时无法打开。');
      setBusy('');
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);
  useEffect(() => {
    if (!dirty && !classDirty && !newProjectDirty && !outlineDirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      if (allowLeave.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty, classDirty, newProjectDirty, outlineDirty]);

  async function saveMaterial() {
    if (!detail) return;
    const draft = await trainingApi<ProjectDetail['draft']>(
      `drafts/${detail.draft.id}`,
      { expectedRevision: detail.draft.revision, content },
      { method: 'PATCH' },
    );
    setDetail((previous) => (previous ? { ...previous, draft } : previous));
    setContent(draft.content);
    return draft;
  }
  function materialSaved(draft: ProjectDetail['draft']) {
    setDetail((previous) => (previous ? { ...previous, draft } : previous));
    setContent(draft.content);
  }
  async function saveClass() {
    if (!detail) return;
    const form = normalizeClassForm(classForm);
    const result = await trainingApi<ClassConfigDraft>(
      `projects/${detail.project.id}/class-draft`,
      { expectedRevision: classDraft?.revision ?? 0, ...form },
      { method: 'PATCH' },
    );
    setClassDraft(result);
    setClassForm(form);
    setClassBaseline(JSON.stringify(form));
    return form;
  }
  function saveDraft() {
    void run('正在保存草稿…', async () => {
      await saveMaterial();
      setNotice('草稿已保存。');
    });
  }
  function selectPreparationPage(pageId: string) {
    if (!detail) return;
    setPreparationLocation({ section: 'slides', pageId });
    navigation.commit(
      {
        view: 'project',
        projectId: detail.project.id,
        tab: 'preparation',
        section: 'slides',
        pageId,
      },
      true,
    );
  }
  function saveConfiguration() {
    void run('正在保存班级配置…', async () => {
      await saveClass();
      setNotice('班级配置已保存，刷新后可以继续。');
    });
  }
  function confirmMaterial() {
    void run('正在确认试讲版本…', async () => {
      if (!detail) return;
      const draft = await saveMaterial();
      if (!draft) return;
      const version = await trainingApi<ProjectDetail['materials'][number]>(
        `drafts/${draft.id}/confirm`,
        { expectedRevision: draft.revision },
      );
      const project = await trainingApi<ProjectDetail>(`projects/${detail.project.id}`);
      setDetail(project);
      setContent(project.draft.content);
      setClassForm((form) => ({ ...form, materialVersionId: version.id }));
      setNotice(`材料版本 V${version.number} 已确认，历史内容将保留。`);
      navigation.commit({ view: 'project', projectId: project.project.id, tab: 'class' });
    });
  }
  function createProject() {
    void run('正在创建备课…', async () => {
      const project = await trainingApi<TrainingProject>('projects', {
        ...newProject,
        clientRequestId: operationKey(newProject),
      });
      const target: TrainingLocation = {
        view: 'project',
        projectId: project.id,
        tab: 'preparation',
      };
      await loadLocation(target);
      await refreshOverview();
      navigation.commit(target, true);
    });
  }
  function createSession() {
    void run('正在准备本轮课堂…', async () => {
      if (!detail || dirty) throw new Error('请先保存材料草稿，再进入课堂。');
      const form = await saveClass();
      if (!form) return;
      const operation = operationKey({ projectId: detail.project.id, ...form });
      const config = await trainingApi<{ id: string }>('class-configs', {
        projectId: detail.project.id,
        template: form.template,
        students: form.students,
        clientRequestId: operation,
      });
      const session = await trainingApi<TrainingSession>('sessions', {
        projectId: detail.project.id,
        materialVersionId: form.materialVersionId,
        classConfigVersionId: config.id,
        inputMode: 'mixed',
        assistance: 'independent',
        scope: 'full',
        plannedMinutes: form.plannedMinutes,
        clientRequestId: operation,
      });
      allowLeave.current = true;
      window.location.assign(classroomHref(session.id));
    });
  }
  function openClassroom(id: string) {
    if (!canLeave({ view: 'home' })) return;
    allowLeave.current = true;
    window.location.assign(classroomHref(id));
  }
  function reload() {
    void run('正在重新读取…', async () => {
      setCapability(await trainingApi<TrainingCapability>('capabilities'));
      await refreshOverview();
      if (!detail) await loadLocation(navigation.location);
      else {
        const next = await trainingApi<ProjectDetail>(`projects/${detail.project.id}`);
        const savedClass = await trainingApi<ClassConfigDraft | null>(
          `projects/${detail.project.id}/class-draft`,
        );
        setDetail(next);
        setClassDraft(savedClass);
        if (sessionDetail)
          setSessionDetail(
            await trainingApi<SessionDetail>(`sessions/${sessionDetail.session.id}`),
          );
        setNotice('已读取最新保存状态，当前输入保留。请核对后再次操作。');
      }
    });
  }

  return {
    capability,
    overview,
    detail,
    content,
    setContent,
    sessionDetail,
    classForm,
    setClassForm,
    classDirty,
    newProject,
    setNewProject,
    busy,
    error,
    notice,
    setNotice,
    preparationLocation,
    preparationVisited,
    selectPreparationPage,
    dirty,
    outlineDirty,
    setOutlineDirty,
    navigation,
    setDocumentBusy,
    saveMaterial,
    materialSaved,
    saveDraft,
    saveConfiguration,
    confirmMaterial,
    createProject,
    createSession,
    openClassroom,
    reload,
    classValid: classDraftSchema.safeParse({
      expectedRevision: 0,
      ...normalizeClassForm(classForm),
    }).success,
  };
}
