'use client';
import dynamic from 'next/dynamic';
import type { SettingsSection } from '@/lib/types/settings';

const SettingsDialog = dynamic(
  () => import('@/components/settings').then((module) => module.SettingsDialog),
  { ssr: false },
);
export function TrainingSettings({
  open,
  onOpenChange,
  initialSection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSection;
}) {
  return open ? (
    <SettingsDialog open={open} onOpenChange={onOpenChange} initialSection={initialSection} />
  ) : null;
}
