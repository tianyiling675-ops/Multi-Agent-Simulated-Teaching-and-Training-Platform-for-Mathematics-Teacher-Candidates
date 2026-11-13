'use client';
import { ChevronDown, ArrowRight, CircleCheck, CircleHelp, Minus, Plus, Users } from 'lucide-react';
import { classTemplates, initialStudent, type ClassForm } from '@/lib/teacher-training/class-form';
import type { useTrainingWorkspace } from './use-training-workspace';
import { ModelReadiness } from './model-readiness';
import styles from './workbench.module.css';

export function ClassConfiguration({
  workspace: w,
}: {
  workspace: ReturnType<typeof useTrainingWorkspace>;
}) {
  const { detail, classForm: form, busy } = w;
  if (!detail) return null;
  const version = detail.materials.find((material) => material.id === form.materialVersionId);
  function update(patch: Partial<ClassForm>) {
    w.setClassForm((current) => ({ ...current, ...patch }));
  }
  function template(id: ClassForm['template']) {
    if (id === form.template) return;
    const expected = form.students.map((_, index) => initialStudent(form.template, index));
    if (
      JSON.stringify(expected) !== JSON.stringify(form.students) &&
      !window.confirm('切换模板会重置学生画像。是否放弃自定义配置并使用新模板？')
    )
      return;
    update({ template: id, students: form.students.map((_, index) => initialStudent(id, index)) });
  }
  function count(value: number) {
    const total = Math.max(1, Math.min(8, value || 1));
    if (
      total < form.students.length &&
      !window.confirm('减少人数会移除末尾学生的当前配置，确定继续？')
    )
      return;
    update({
      students: Array.from(
        { length: total },
        (_, index) => form.students[index] ?? initialStudent(form.template, index),
      ),
    });
  }
  return (
    <div className={styles.classLayout}>
      <section className={styles.classEditor}>
        <h2 className={styles.editorialTitle}>为这一轮，准备一个班级</h2>
        <p className={styles.subtitle}>先选学情模板，再按需要调整学生。</p>
        <div className={styles.templateGrid}>
          {classTemplates.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={!!busy}
              aria-pressed={form.template === item.id}
              onClick={() => template(item.id)}
            >
              <Users size={23} />
              <strong>{item.title}</strong>
              <span>{item.description}</span>
              <p>{item.detail}</p>
            </button>
          ))}
        </div>
        <div className={styles.sectionTitle}>
          <h2>本轮虚拟学生</h2>
          <div className={styles.counter}>
            <span>{form.students.length} 位学生</span>
            <button
              aria-label="减少学生"
              disabled={!!busy || form.students.length <= 1}
              onClick={() => count(form.students.length - 1)}
            >
              <Minus size={15} />
            </button>
            <button
              aria-label="增加学生"
              disabled={!!busy || form.students.length >= 8}
              onClick={() => count(form.students.length + 1)}
            >
              <Plus size={15} />
            </button>
          </div>
        </div>
        {form.students.map((student, index) => (
          <details className={styles.studentConfig} key={student.id} open={undefined}>
            <summary>
              <span className={styles.studentAvatar}>{student.name.slice(-1) || index + 1}</span>
              <strong>{student.name || '未命名学生'}</strong>
              <span className={styles.chip}>
                {
                  { active: '主动表达', responsive: '愿意回应', reserved: '需要鼓励' }[
                    student.expression
                  ]
                }
              </span>
              <span className={styles.studentSummary}>
                {student.priorKnowledge || '展开配置本课知识基础'}
              </span>
              <ChevronDown size={16} />
            </summary>
            <div className={styles.studentFields}>
              <label>
                学生名称
                <input
                  maxLength={200}
                  value={student.name}
                  disabled={!!busy}
                  onChange={(e) =>
                    update({
                      students: form.students.map((s, i) =>
                        i === index ? { ...s, name: e.target.value } : s,
                      ),
                    })
                  }
                />
              </label>
              <label>
                表达特点
                <select
                  value={student.expression}
                  disabled={!!busy}
                  onChange={(e) =>
                    update({
                      students: form.students.map((s, i) =>
                        i === index
                          ? { ...s, expression: e.target.value as typeof student.expression }
                          : s,
                      ),
                    })
                  }
                >
                  <option value="active">主动表达</option>
                  <option value="responsive">愿意回应</option>
                  <option value="reserved">需要鼓励</option>
                </select>
              </label>
              <label className={styles.fullWidth}>
                本课知识基础
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={student.priorKnowledge}
                  disabled={!!busy}
                  onChange={(e) =>
                    update({
                      students: form.students.map((s, i) =>
                        i === index ? { ...s, priorKnowledge: e.target.value } : s,
                      ),
                    })
                  }
                />
              </label>
              <label className={styles.fullWidth}>
                本课常见误解（每行一条，仅用于学生模拟）
                <textarea
                  rows={2}
                  maxLength={5000}
                  value={student.misconceptions.join('\n')}
                  disabled={!!busy}
                  onChange={(e) =>
                    update({
                      students: form.students.map((s, i) =>
                        i === index
                          ? { ...s, misconceptions: e.target.value.split('\n').slice(0, 10) }
                          : s,
                      ),
                    })
                  }
                />
              </label>
            </div>
          </details>
        ))}
        <div className={styles.cardActions}>
          <button disabled={!!busy || !w.classDirty || !w.classValid} onClick={w.saveConfiguration}>
            保存班级配置
          </button>
          <span className={styles.muted}>
            {w.classDirty ? '班级配置有未保存修改' : '修改后可保存，下次从这里继续'}
          </span>
        </div>
      </section>
      <aside className={styles.readinessPanel}>
        <h2>本轮训练安排</h2>
        <h3 className={styles.smallHeading}>选择本轮材料</h3>
        <label>
          已确认版本
          <select
            value={form.materialVersionId ?? ''}
            disabled={!!busy}
            onChange={(e) => update({ materialVersionId: e.target.value || null })}
          >
            <option value="">请先确认材料版本</option>
            {detail.materials.map((material) => (
              <option key={material.id} value={material.id}>
                V{material.number} · {new Date(material.createdAt).toLocaleDateString('zh-CN')}
              </option>
            ))}
          </select>
        </label>
        <dl>
          <div>
            <dt>课件</dt>
            <dd>
              {version?.content.pages?.length ? `${version.content.pages.length} 页` : '白板试讲'}
            </dd>
          </div>
          <div>
            <dt>虚拟学生</dt>
            <dd>{form.students.length} 位</dd>
          </div>
          <div>
            <dt>训练范围</dt>
            <dd>完整试讲</dd>
          </div>
        </dl>
        <label>
          预设时长（分钟）
          <input
            type="number"
            min={1}
            max={180}
            disabled={!!busy}
            value={form.plannedMinutes}
            onChange={(e) => update({ plannedMinutes: Number(e.target.value) })}
          />
        </label>
        <div className={styles.minuteOptions}>
          {[10, 15, 20].map((minutes) => (
            <button
              key={minutes}
              aria-pressed={form.plannedMinutes === minutes}
              disabled={!!busy}
              onClick={() => update({ plannedMinutes: minutes })}
            >
              {minutes} 分钟
            </button>
          ))}
        </div>
        <p className={styles.readinessLine}>
          {version ? <CircleCheck size={18} /> : <CircleHelp size={18} />}
          {version ? `材料 V${version.number} 已确认` : '请先完成材料准备'}
        </p>
        <ModelReadiness />
        <p className={styles.hint}>正式评分待配置评价标准</p>
        {w.dirty && (
          <p className={styles.hint}>
            教案或课件有未保存修改，请先保存。本轮采用所选的已确认版本。
          </p>
        )}
        <button
          className={styles.primary}
          disabled={!!busy || w.dirty || !form.materialVersionId || !w.classValid}
          onClick={w.createSession}
        >
          进入模拟课堂 <ArrowRight size={17} />
        </button>
        <button
          disabled={!!busy}
          onClick={() =>
            w.navigation.navigate({
              view: 'project',
              projectId: detail.project.id,
              tab: 'preparation',
            })
          }
        >
          返回材料准备
        </button>
        <p className={styles.muted}>
          进入后，由你点击“开始课堂”。学生只会依据本轮公开的讲解、课件与板书回应。
        </p>
      </aside>
    </div>
  );
}
