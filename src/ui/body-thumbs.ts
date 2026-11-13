/**
 * 印章主体样式缩略图（内联 SVG）。
 * 左：前视剪影(X-Z)；右：顶视剪影(X-Y)。统一比例尺，currentColor 纯填充，无 stroke。
 * 由 temp/gen-thumbs.mjs 从 public/bodies/*.stl 生成，勿手改。
 */
export type BodyId = 'classic' | 'cylinder' | 'column' | 'dome';

export const BODY_THUMBS: Record<BodyId, string> = {
  classic: "<svg viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M15 18.8L17.9 18.9L20.2 19.8L21.3 20.8L22 22.4L22 24L21.3 26L19.3 27.6L19.3 39.1L29.1 39.1L29.1 45.2L2.9 45.2L2.9 39.1L12.7 39.1L12.7 27.6L10.7 26L10 24.1L10 22.4L11.4 20.1L13.1 19.2L15 18.8ZM46.1 19.1L51.2 19.3L55.7 21.4L58.2 23.7L59.4 25.4L60.9 29.7L60.8 34.9L60 37.3L58.6 39.7L55 43.1L52.9 44.2L49.9 44.9L45.3 44.8L42.2 43.8L40.3 42.6L37 39.2L35.8 37L35.1 34.3L35.2 29.1L36 26.7L37.4 24.3L41 20.9L43.1 19.8L46.1 19.1Z\"/></svg>",
  cylinder: "<svg viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M7.9 14.6L24.2 14.8L24.2 49.4L7.8 49.4L7.9 14.6ZM46.6 23.9L50 24.1L52.7 25.2L54.8 27.3L56.1 30.3L56.1 33.7L55 36.3L53.1 38.5L49.6 40.1L46.4 40.1L43.7 39L41.4 36.9L39.9 33.8L39.8 31L41.1 27.4L43.7 25L46.6 23.9Z\"/></svg>",
  column: "<svg viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M8.4 15.2L23.6 15.4L23.6 48.8L8.3 48.8L8.4 15.2ZM40.3 24.4L55.6 24.4L55.6 39.6L40.3 39.6L40.3 24.4Z\"/></svg>",
  dome: "<svg viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><path fill=\"currentColor\" fill-rule=\"evenodd\" d=\"M14.6 19.5L17.4 19.5L20.2 20.3L23.5 22.4L25.4 24.8L26.7 28.4L26.6 32.9L24.9 36.7L22.3 39.3L27.1 39.3L27.1 41.2L29.1 41.2L29.1 44.5L2.9 44.5L2.9 41.2L4.9 41.2L4.9 39.3L9.7 39.3L7.1 36.7L5.5 33.4L5.1 29.3L5.9 26.1L7.4 23.7L9.3 21.7L11.8 20.3L14.6 19.5ZM46.1 19.1L51.2 19.3L55.7 21.4L58.2 23.7L59.4 25.4L60.9 29.7L60.8 34.9L60 37.3L58.6 39.7L55 43.1L52.9 44.2L49.9 44.9L45.3 44.8L42.2 43.8L40.3 42.6L37 39.2L35.8 37L35.1 34.3L35.2 29.1L36 26.7L37.4 24.3L41 20.9L43.1 19.8L46.1 19.1Z\"/></svg>",
};
