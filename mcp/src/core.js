/**
 * The only module allowed to import StykAnimate internals.
 * Everything else in mcp/ talks to the app through the exports below, so an
 * upstream merge that renames an editor entry point is fixed here.
 */
import './file-fetch.js';

export {Editor} from '../../src/editor.mjs';
export {validateScene} from '../../src/pivot/model.mjs';
export {emptyDocument, createObject, createFrame, defaultFigure} from '../../src/demo.mjs';
export {createStartupDocument, STARTUP_CANVASES} from '../../src/startup-document.mjs';
export {createBlueStartupPose} from '../../src/startup-blue-data.mjs';
export {decodeDocument, buildContainerV2, normalizeDecodedDocument} from '../../src/native-container.mjs';
export {nativeFigureDocument} from '../../src/native-figure.mjs';
export {buildGeometry, evaluatedFrame, timeline} from '../../src/pivot/geometry.mjs';
export {cameraMatrix} from '../../src/renderer-geometry.mjs';
export {frameWithCameraTime, cameraAtTime} from '../../src/camera-motion.mjs';
export {createTextFigure} from '../../src/text-authoring.mjs';
export {inspectWave, wavePeaks} from '../../src/audio-pcm.mjs';
export {AUDIO_CHUNK_BYTES, audioState} from '../../src/audio-model.mjs';
export {ensureLayerState, LAYER_COLORS} from '../../src/layers.mjs';

/** Desktop-matching editor. Layer timeline and per-figure colors match src/app.mjs. */
export const EDITOR_OPTIONS = Object.freeze({
  demo: false,
  propertyChannels: true,
  layerTimeline: true,
  historyLimit: 200,
});
