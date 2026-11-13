import type { Metadata } from 'next';
import { PRODUCT_NAME } from '@/lib/brand/brand-config';
import LegacyOpenMAICHome from '@/components/legacy/openmaic-home';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} · 学习模式`,
  robots: { index: false, follow: false },
};

export default function LegacyPage() {
  return <LegacyOpenMAICHome />;
}
