# manifold/opentype 实测记录（Node 22, 本机）
manifold-3d@3.5.5: wasm 530KB + glue 80KB; import+init 20ms;
  606 截面并集 120ms; 挤出+布尔 25ms; 5042 面; simplify(0.02)->2376 面 仍 NoError; RSS 56MB
  40mm 章体(圆角+手柄+126 笔画): 4074 面, STL 199KB, 导出 3ms, status NoError
  inward offset 0.2mm: 文字面积 331 -> 179 mm^2（细笔画消失约 46%）
opentype.js@2.0.0: min.mjs 240KB; 无 WOFF2（源码抛错要求外部解压器）
potrace-wasm@1.0.4: tgz 111KB / index.js 274KB
imagetracerjs@1.2.6: tgz 3.0MB（主要是示例图）
