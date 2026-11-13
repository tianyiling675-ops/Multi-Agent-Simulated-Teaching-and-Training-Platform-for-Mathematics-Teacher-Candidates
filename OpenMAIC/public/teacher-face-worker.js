/* global importScripts, OffscreenCanvas */
const runtime = '/teacher-face-runtime/0.10.32';
const modelAssetPath = '/teacher-face-model/face-landmarker-fp16-v1.task';
let landmarker;

async function initialize() {
  // The published CommonJS bundle uses exports. Its WASM loader needs a classic worker.
  self.exports = {};
  importScripts(`${runtime}/vision_bundle.js`);
  const { FilesetResolver, FaceLandmarker } = self.exports;
  delete self.exports;
  const files = await FilesetResolver.forVisionTasks(`${runtime}/wasm`);
  landmarker = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath },
    canvas: new OffscreenCanvas(1, 1),
    runningMode: 'VIDEO',
    numFaces: 2,
    outputFaceBlendshapes: true,
  });
  self.postMessage({ type: 'ready' });
}

function observe(image, timestamp) {
  try {
    const faces = landmarker.detectForVideo(image, timestamp).faceBlendshapes;
    if (faces.length !== 1) return null;
    const scores = new Map(
      faces[0].categories.map(({ categoryName, score }) => [categoryName, score]),
    );
    const above = (left, right, threshold) =>
      ((scores.get(left) ?? 0) + (scores.get(right) ?? 0)) / 2 >= threshold;
    return {
      smile: above('mouthSmileLeft', 'mouthSmileRight', 0.55),
      browDown: above('browDownLeft', 'browDownRight', 0.55),
      browUp:
        (scores.get('browInnerUp') ?? 0) >= 0.55 ||
        above('browOuterUpLeft', 'browOuterUpRight', 0.55),
    };
  } finally {
    image.close();
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'init') {
    void initialize().catch(() => self.postMessage({ type: 'error' }));
  } else if (data.type === 'frame') {
    try {
      const actions = observe(data.image, data.timestamp);
      self.postMessage({ type: 'sample', timestamp: data.timestamp, actions });
    } catch {
      self.postMessage({ type: 'error' });
    }
  }
};
