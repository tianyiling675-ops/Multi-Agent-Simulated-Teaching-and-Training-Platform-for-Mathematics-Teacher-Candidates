import type { SessionDetail } from './contracts';
import type { EvidenceRow } from './review-model';

export const reviewRubricVersion = '1.0';

const rubric = [
  {
    title: '教学内容',
    items: [
      {
        id: 'concepts',
        title: '数学概念表述',
        weight: 15,
        criterion: '核心定义、符号、适用条件与例子相符，表述足以区分相近概念。',
      },
      {
        id: 'key-points',
        title: '重点难点',
        weight: 8,
        criterion: '指出本课重点，并用解释、示例或检查处理实际难点。',
      },
      {
        id: 'structure',
        title: '讲解逻辑与知识结构',
        weight: 10,
        criterion: '概念、推导与例题的先后有依据，过渡交代了前后联系。',
      },
      {
        id: 'accuracy',
        title: '数学推理与运算核验',
        weight: 7,
        criterion: '推导、计算和结论正确。定义与术语归入概念表述，同一处错误只计一次。',
      },
    ],
  },
  {
    title: '教学方法',
    items: [
      {
        id: 'stages',
        title: '教学环节设计',
        weight: 10,
        criterion: '环节服务本轮目标，衔接清楚。按任务范围判断练习、总结和作业是否适用。',
      },
      {
        id: 'methods',
        title: '教学方法适配',
        weight: 12,
        criterion: '所选例题、图示或演示帮助解释当前知识点，难度与目标相符。',
      },
      {
        id: 'thinking',
        title: '思维引导',
        weight: 8,
        criterion: '提问要求解释理由、比较或推理，并根据回答反馈或追问。',
      },
    ],
  },
  {
    title: '课堂表现',
    items: [
      {
        id: 'speech',
        title: '口语表达',
        weight: 8,
        criterion: '结合原始音频复核术语发音、语句清晰度、语速和停顿。',
      },
      {
        id: 'presence',
        title: '教态',
        weight: 4,
        criterion: '结合授课视频观察面向学生、姿态及读稿情况。',
      },
      {
        id: 'board',
        title: '数字板书',
        weight: 4,
        criterion: '板书层次可辨，文字、符号和公式清楚，与讲解配合。',
      },
      {
        id: 'interaction',
        title: '互动与时间分配',
        weight: 4,
        criterion: '检查教师提供作答机会的方式与分布。时间分配需对照计划和各环节起止。',
      },
    ],
  },
  {
    title: '教学效果',
    items: [
      {
        id: 'objectives',
        title: '目标回扣与理解检查',
        weight: 4,
        criterion: '结尾回扣预设目标，并用针对性练习或迁移题检查理解。',
      },
      {
        id: 'participation',
        title: '虚拟学生参与',
        weight: 3,
        criterion: '观察回应机会是否集中在少数虚拟学生，回看教师如何接续不同回答。',
      },
      {
        id: 'extension',
        title: '思想方法与拓展',
        weight: 3,
        criterion: '提炼可迁移的数学思想，或提供能解释本课概念的应用、变式和开放题。',
      },
    ],
  },
] as const;

type ItemId = (typeof rubric)[number]['items'][number]['id'];
export const reviewFeedbackLabels = {
  evidence: '有记录可回看',
  manual: '待教师复核',
  insufficient: '证据不足',
  notApplicable: '本轮不适用',
};

type Feedback = {
  status: keyof typeof reviewFeedbackLabels;
  note: string;
  rows: EvidenceRow[];
  material?: boolean;
};

function feedback(note: string, ...candidates: (EvidenceRow | undefined)[]): Feedback {
  const rows = [...new Set(candidates.filter((row): row is EvidenceRow => Boolean(row)))].sort(
    (a, b) => a.seq - b.seq,
  );
  return { status: rows.length ? 'evidence' : 'insufficient', note, rows };
}

export function reviewFeedback(
  detail: SessionDetail,
  rows: EvidenceRow[],
  faceRows: EvidenceRow[] = [],
) {
  const teacher = rows.filter((row) => row.type === 'teacher_text' && row.text);
  const explanations = teacher.filter((row) => row.intent === 'explain' || !row.intent);
  const questions = teacher.filter((row) => row.intent === 'question');
  const checks = teacher.filter((row) => row.intent === 'check');
  const answers = rows.filter((row) => row.type === 'student_speech' && row.text);
  const pages = rows.filter((row) => row.type === 'page_exposure');
  const boardAdds = new Set(
    detail.events
      .filter(
        (event) => event.type === 'board_operation' && event.payload.operation?.kind === 'add',
      )
      .map((event) => event.id),
  );
  const board = rows.filter((row) => boardAdds.has(row.id));
  const content = detail.material.content;
  const hasObjectives = Boolean(content.objectives.trim());
  const lastExplanation = explanations.at(-1);
  const firstQuestion = questions[0];
  const firstAnswer = answers[0];
  const nextTeacher = firstAnswer && teacher.find((row) => row.seq > firstAnswer.lastSeq);
  const nextCheck = firstAnswer && checks.find((row) => row.seq > firstAnswer.lastSeq);
  const responding = new Set(
    answers.flatMap((row) => (row.studentId && !row.rehearsalSeed ? [row.studentId] : [])),
  );

  const byItem: Record<ItemId, Feedback> = {
    concepts: feedback(
      '抽查已记录的讲解和展示内容，核对定义、符号与适用条件。',
      explanations[0],
      pages[0],
    ),
    'key-points': {
      ...feedback(
        content.keyPoints.trim()
          ? '对照教案中的重难点，回看讲解与理解检查是否覆盖。'
          : '材料未单列重难点。回看讲解，并补写本轮要处理的具体困难。',
        explanations[0],
        checks[0],
      ),
      material: Boolean(content.keyPoints.trim()),
    },
    structure: feedback(
      '对照前后讲解，检查概念、推导与例题的过渡是否说清楚。',
      explanations[0],
      lastExplanation,
    ),
    accuracy: {
      ...feedback(
        '请用本课教材或教师审定的答案复核。发现疑似错误时先核对公式转写、板书与原意。',
        lastExplanation,
        board.at(-1),
        pages.at(-1),
      ),
      status: lastExplanation || board.length || pages.length ? 'manual' : 'insufficient',
    },
    stages: {
      ...feedback(
        '对照教学计划和前后发言检查环节衔接。记录时间可用于定位片段。',
        teacher[0],
        teacher.at(-1),
      ),
      material: Boolean(content.process.trim() || content.segments.length),
    },
    methods: feedback(
      '回看课件、板书或提问，检查所用示例是否帮助学生理解这一知识点。',
      pages[0],
      board[0],
      firstQuestion ?? explanations[0],
    ),
    thinking: feedback(
      nextCheck
        ? '学生回答之后有理解检查记录。对照两段发言，看看检查题是否要求解释理由或迁移。'
        : firstAnswer
          ? '这条学生回答之后未记录标记为理解检查的发言。先回看教师反馈，再考虑加一道要求说明理由的变式题。'
          : '当前记录没有可回看的学生回答。可检查提问是否要求说明理由，并在下轮安排点名和追问。',
      firstAnswer
        ? teacher.findLast((row) => row.seq < firstAnswer.seq)
        : (firstQuestion ?? checks[0]),
      firstAnswer,
      nextCheck ?? nextTeacher,
    ),
    speech:
      detail.session.trainingConfig.inputMode === 'text'
        ? { status: 'notApplicable', note: '本轮采用文字模式。', rows: [] }
        : feedback('复核语速、停顿和术语发音需要可回听的授课音频。'),
    presence: faceRows.length
      ? feedback(
          '可对照表情证据与课堂片段复核面部动作。完整教态仍需对应画面。',
          ...faceRows.slice(0, 3),
        )
      : feedback('本轮可用于教态复核的表情或视频证据不足。'),
    board: feedback(
      board.length
        ? '打开板书片段，检查关键步骤、公式和版面层次。'
        : '本轮记录没有可回看的数字板书写入事件。',
      board[0],
      board.at(-1),
    ),
    interaction: feedback(
      `记录到全班提问 ${questions.length} 次、理解检查 ${checks.length} 次、已发布回答 ${answers.filter((row) => !row.rehearsalSeed).length} 轮。各环节时间分配需另有起止标注。`,
      firstQuestion,
      rows.find((row) => row.type === 'call_on'),
      checks[0],
      firstAnswer,
    ),
    objectives: {
      ...feedback(
        hasObjectives
          ? '对照预设目标，回看结尾发言和理解检查。可用变式题检查虚拟学生能否说明理由。'
          : '本轮材料未填写预设目标。先补写目标，再核对小结和检查题是否覆盖。',
        checks.at(-1),
        teacher.at(-1),
      ),
      ...(hasObjectives ? { material: true } : { status: 'insufficient' as const }),
    },
    participation: feedback(
      `有已发布回答的虚拟学生为 ${responding.size}／${detail.classConfig.students.length} 人。现场学生的课堂气氛在本模式下不适用。`,
      firstAnswer,
      answers.find((row) => row.studentId !== firstAnswer?.studentId),
    ),
    extension: feedback(
      '回看讲解和结尾，检查是否提炼了数学思想，或给出了可以迁移到新情境的任务。',
      checks.at(-1),
      lastExplanation,
    ),
  };

  return rubric.map(({ title, items }) => ({
    title,
    weight: items.reduce((sum, item) => sum + item.weight, 0),
    items: items.map((item) => ({ ...item, ...byItem[item.id] })),
  }));
}
