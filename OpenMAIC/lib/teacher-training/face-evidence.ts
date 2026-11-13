import { z } from 'zod';

export const faceActions = {
  smile: '嘴角上扬',
  browDown: '眉部下压',
  browUp: '眉部抬起',
} as const;

export const faceModelVersion = 'mediapipe-0.10.32/face-landmarker-fp16-v1/actions-v1';
export const faceWindowMs = 2_000;
export const faceSampleMs = 250;
export const maxFaceWindows = 5_400;

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().min(0).max(16);
const windowSchema = z
  .object({
    id: z.uuid(),
    startedAt: time,
    endedAt: time,
    samples: count.min(1),
    visible: count,
    smile: count,
    browDown: count,
    browUp: count,
  })
  .strict()
  .refine((w) => w.endedAt >= w.startedAt && w.endedAt - w.startedAt <= faceWindowMs)
  .refine(
    (w) =>
      w.visible <= w.samples &&
      Object.keys(faceActions).every((key) => w[key as keyof typeof faceActions] <= w.visible),
  );

export const faceUploadSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    modelVersion: z.literal(faceModelVersion),
    windows: z.array(windowSchema).min(1).max(40),
  })
  .strict();

export type FaceWindow = z.infer<typeof windowSchema>;
export type FaceUpload = z.infer<typeof faceUploadSchema>;
export type FaceEvidence = { generation: number; modelVersion: string; windows: FaceWindow[] };
export type FaceEvidenceResponse = FaceEvidence & { serverTime: number };

export const emptyFaceEvidence = (): FaceEvidence => ({
  generation: 0,
  modelVersion: faceModelVersion,
  windows: [],
});

export function summarizeFaceWindows(windows: FaceWindow[]) {
  const samples = windows.reduce((sum, w) => sum + w.samples, 0);
  const visible = windows.reduce((sum, w) => sum + w.visible, 0);
  const usable = visible >= 3 && visible * 2 >= samples;
  return {
    samples,
    visible,
    usable,
    actions: usable
      ? (Object.keys(faceActions) as (keyof typeof faceActions)[]).filter((key) =>
          windows.some((w) => w[key] >= 3 && w.visible * 2 >= w.samples),
        )
      : [],
  };
}
