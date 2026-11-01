import type { Slide, SlideTheme } from '@openmaic/dsl';
export const defaultTheme: SlideTheme = {
  themeColors: ['#35594b', '#af7041', '#688292', '#d7c8a5', '#68937a', '#c9d9d1'],
  fontColor: '#263e36',
  fontName: 'Noto Sans SC',
  backgroundColor: '#ffffff',
  shadow: { h: 0, v: 0, blur: 0, color: '#000000' },
  outline: { width: 1, color: '#35594b', style: 'solid' },
};
export function blankSlide(id: string): Slide {
  return {
    id,
    elements: [],
    background: { type: 'solid', color: '#ffffff' },
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: defaultTheme,
  };
}
