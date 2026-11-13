import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const bundle = require.resolve('@mediapipe/tasks-vision');
const wasm = join(dirname(bundle), 'wasm');
const destination = new URL('../public/teacher-face-runtime/0.10.32/', import.meta.url);
mkdirSync(new URL('wasm/', destination), { recursive: true });
copyFileSync(bundle, new URL('vision_bundle.js', destination));
for (const file of readdirSync(wasm)) {
  if (file.endsWith('.wasm') || file.endsWith('.js')) {
    copyFileSync(join(wasm, file), new URL(`wasm/${file}`, destination));
  }
}
