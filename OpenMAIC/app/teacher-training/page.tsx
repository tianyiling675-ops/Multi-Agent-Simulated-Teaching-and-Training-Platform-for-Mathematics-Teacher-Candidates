import type { Metadata } from 'next';
import { TrainingWorkbench } from '@/components/teacher-training/workbench';
import { parseTrainingLocation } from '@/lib/teacher-training/navigation';

export const metadata: Metadata = {
  title: '教师训练 · OpenMAIC',
  description: '数学教师的备课、材料版本与课堂训练记录。',
};

export default async function TeacherTrainingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === 'string') query.set(key, value);
  }
  return <TrainingWorkbench initialLocation={parseTrainingLocation(query.toString())} />;
}
