export { getAnimationDuration, getAnimationFPS, getAnimationMode, setMorphEnd, setMorphStart } from './animation.ts';
export type { GLTFAttribute, GLTFMaterial } from './gltf-node.ts';
export { CrossSectionGLTFNode, GLTFNode, VisualizationGLTFNode } from './gltf-node.ts';
export { importManifold, importModel } from './import-model.ts';
export { getCircularSegments, getMinCircularAngle, getMinCircularEdgeLength } from './level-of-detail.ts';
declare const Mesh: typeof import("../manifold.d.ts").Mesh, Manifold: typeof import("../manifold.d.ts").Manifold, CrossSection: typeof import("../manifold.d.ts").CrossSection, triangulate: typeof import("../manifold.d.ts").triangulate;
declare const show: any;
declare const only: any;
declare const setMaterial: any;
declare const getGLTFNodes: () => never[];
declare const resetGLTFNodes: () => void;
declare const isManifoldCAD: () => boolean;
export { Mesh, Manifold, CrossSection, triangulate, show, only, setMaterial, getGLTFNodes, resetGLTFNodes, isManifoldCAD };
//# sourceMappingURL=manifoldCAD.d.ts.map