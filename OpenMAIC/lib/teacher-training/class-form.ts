import type { ClassConfigDraft, Student, TrainingSession } from './contracts';

export type ClassForm = Pick<
  ClassConfigDraft,
  'template' | 'students' | 'plannedMinutes' | 'materialVersionId'
>;
export const classTemplates = [
  {
    id: 'strong',
    title: '基础较好',
    description: '练习深入追问',
    detail: '已有较扎实的知识基础，适合深入解释与拓展。',
  },
  {
    id: 'mixed',
    title: '水平混合',
    description: '练习兼顾差异',
    detail: '不同基础与表达特点，练习分层提问和支持。',
  },
  {
    id: 'support',
    title: '基础薄弱',
    description: '练习分步解释',
    detail: '用具体例子与清楚的步骤，帮助学生突破困难。',
  },
] as const;
export const studentNames = ['小林', '小周', '小陈', '小许', '小赵', '小吴', '小唐', '小叶'];
export function initialStudent(template: ClassForm['template'], index: number): Student {
  return {
    id: `student_${index + 1}`,
    name: studentNames[index],
    priorKnowledge:
      template === 'strong'
        ? '前置知识较熟悉，仍需检查具体理解。'
        : template === 'support'
          ? '需要具体例子和分步支持。'
          : ['前置知识较熟悉。', '能完成基础问题，解释关系时需要支持。', '部分前置概念仍需澄清。'][
              index % 3
            ],
    expression: (['active', 'responsive', 'reserved'] as const)[index % 3],
    misconceptions: [],
  };
}
export const defaultClassForm = (materialVersionId: string | null): ClassForm => ({
  template: 'mixed',
  students: [0, 1, 2].map((index) => initialStudent('mixed', index)),
  plannedMinutes: 15,
  materialVersionId,
});
export const normalizeClassForm = (form: ClassForm): ClassForm => ({
  ...form,
  students: form.students.map((student) => ({
    ...student,
    misconceptions: student.misconceptions.map((value) => value.trim()).filter(Boolean),
  })),
});
export const sessionStatusLabels: Record<TrainingSession['status'], string> = {
  ready: '准备完成',
  running: '进行中',
  paused: '已暂停',
  interrupted: '已中断',
  ended: '已结束',
};
export const trainingDate = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
