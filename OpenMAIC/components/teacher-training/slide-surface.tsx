'use client';
import { memo, useId } from 'react';
import { SlideCanvas } from '@openmaic/renderer';
import type { Slide } from '@openmaic/dsl';

export const TrainingSlide = memo(function TrainingSlide({ slide }: { slide: Slide }) {
  const instance = useId();
  return (
    <SlideCanvas
      slide={slide}
      canvasPercentage={96}
      chrome={false}
      elementIdPrefix={`training-${instance.replace(/[^a-zA-Z0-9_-]/g, '')}-${slide.id}-`}
    />
  );
});
