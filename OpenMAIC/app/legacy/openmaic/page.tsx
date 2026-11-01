import type { Metadata } from 'next';
import LegacyOpenMAICHome from '@/components/legacy/openmaic-home';

export const metadata: Metadata = {
  title: 'OpenMAIC 学习模式 · 兼容入口',
  robots: { index: false, follow: false },
};

export default function LegacyPage() {
  return <LegacyOpenMAICHome />;
}
