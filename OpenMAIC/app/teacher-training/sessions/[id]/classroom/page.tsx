import { TeacherClassroom } from '@/components/teacher-training/teacher-classroom';
export default async function ClassroomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TeacherClassroom sessionId={id} />;
}
