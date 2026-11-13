/**
 * 中心装饰图案缩略图（内联 SVG，24×24）。
 * currentColor 纯填充，无 stroke；由 temp/gen-ornament-thumbs.ts 从 src/layout/ornaments.ts 生成，勿手改。
 * 五角星：外顶点 R、内顶点 0.382R，10 顶点；六芒星：并集轮廓，12 顶点。
 */
export type OrnamentId = 'star' | 'hexagram';

export const ORNAMENT_THUMBS: Record<OrnamentId, string> = {
  star: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M12 2L9.75 8.91L2.49 8.91L8.37 13.18L6.12 20.09L12 15.82L17.88 20.09L15.63 13.18L21.51 8.91L14.25 8.91Z\"/></svg>",
  hexagram: "<svg viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M17.77 12L20.66 7L14.89 7L12 2L9.11 7L3.34 7L6.23 12L3.34 17L9.11 17L12 22L14.89 17L20.66 17Z\"/></svg>",
};
