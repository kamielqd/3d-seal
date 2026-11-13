/**
 * 内置预设模板。
 *
 * 每条预设都按「FDM 能直接打」来配：阴刻 + 盖印面贴床 + 圆钮手柄，
 * 因为阳刻贴床会留下 800mm² 级悬空面（见 DESIGN §6 bridge.span）。
 * 想要阳刻的话，预设里给了「平装无手柄 + face-up」的一键版本。
 */

import {
  createDefaultSpec,
  type BodyShape,
  type PrintOrientation,
  type SealSpec,
} from './spec';

export interface Preset {
  id: string;
  name: string;
  /** 一句话说明这套参数为什么这样配 */
  note: string;
  build: () => SealSpec;
}

function base(): SealSpec {
  const spec = createDefaultSpec();
  const text = spec.layers.find((l) => l.kind === 'text');
  if (text && text.kind === 'text') {
    text.fontId = 'smiley-sans';
    text.fontSizeMm = 7;
    text.letterSpacingMm = 0.8;
  }
  return spec;
}

export const PRESETS: Preset[] = [
  {
    id: 'name-seal',
    name: '姓名章',
    note: '25mm 方章、竖排两字起、朱文改白文（阴刻贴床可直接打）',
    build: () => {
      const spec = base();
      spec.body.shape = 'square';
      spec.body.sizeMm = 25;
      spec.body.cornerRadiusMm = 1.5;
      spec.body.baseThicknessMm = 2.5;
      spec.body.border = { style: 'thin', widthMm: 1, insetMm: 1.2 };
      spec.body.handle = 'knob';
      spec.body.handleHeightMm = 14;
      spec.body.handleDiameterMm = 14;
      spec.relief.mode = 'engraved';
      spec.relief.depthMm = 1.2;
      const t = spec.layers.find((l) => l.kind === 'text');
      if (t && t.kind === 'text') {
        t.text = '张三';
        t.layout = 'vertical';
        t.fontSizeMm = 8;
        t.letterSpacingMm = 1;
      }
      return spec;
    },
  },
  {
    id: 'auspicious',
    name: '吉语章',
    note: '30mm 方章、横排四字吉语，字距放宽避免笔画粘连',
    build: () => {
      const spec = base();
      spec.body.shape = 'square';
      spec.body.sizeMm = 30;
      spec.body.cornerRadiusMm = 2;
      spec.body.border = { style: 'double', widthMm: 1.2, insetMm: 1.5 };
      spec.body.handle = 'knob';
      spec.relief.mode = 'engraved';
      spec.relief.depthMm = 1.2;
      const t = spec.layers.find((l) => l.kind === 'text');
      if (t && t.kind === 'text') {
        t.text = '平安喜乐';
        t.layout = 'horizontal';
        t.fontSizeMm = 6.5;
        t.letterSpacingMm = 1.2;
      }
      return spec;
    },
  },
  {
    id: 'bookplate',
    name: '藏书印',
    note: '32mm 方章、四字回文（右上→右下→左上→左下），藏书印的传统排法',
    build: () => {
      const spec = base();
      spec.body.shape = 'square';
      spec.body.sizeMm = 32;
      spec.body.cornerRadiusMm = 1;
      spec.body.border = { style: 'thick', widthMm: 1.6, insetMm: 1.2 };
      spec.body.handle = 'knob';
      spec.relief.mode = 'engraved';
      spec.relief.depthMm = 1.2;
      const t = spec.layers.find((l) => l.kind === 'text');
      if (t && t.kind === 'text') {
        t.text = '藏书之印';
        t.layout = 'huiwen';
        t.fontSizeMm = 7;
        t.letterSpacingMm = 0.8;
      }
      return spec;
    },
  },
  {
    id: 'round-ring',
    name: '圆章环读',
    note: '40mm 圆章、六字环形、字头朝外；圆章环形要先确认字不挤',
    build: () => {
      const spec = base();
      spec.body.shape = 'circle' as BodyShape;
      spec.body.sizeMm = 40;
      spec.body.border = { style: 'thin', widthMm: 1.2, insetMm: 1.5 };
      spec.body.handle = 'knob';
      spec.body.handleDiameterMm = 16;
      spec.relief.mode = 'engraved';
      spec.relief.depthMm = 1.2;
      const t = spec.layers.find((l) => l.kind === 'text');
      if (t && t.kind === 'text') {
        t.text = '吉祥如意万事顺';
        t.layout = 'ring';
        t.fontSizeMm = 6;
        t.letterSpacingMm = 1;
        t.ringSpanDeg = 360;
      }
      return spec;
    },
  },
  {
    id: 'flat-raised',
    name: '平装阳刻',
    note: '无手柄 + 背面贴床（face-up）：阳刻唯一能不靠支撑打出来的组合',
    build: () => {
      const spec = base();
      spec.body.shape = 'square';
      spec.body.sizeMm = 30;
      spec.body.cornerRadiusMm = 1.5;
      spec.body.handle = 'none';
      spec.relief.mode = 'raised';
      spec.relief.depthMm = 1.2;
      spec.print.orientation = 'face-up' as PrintOrientation;
      const t = spec.layers.find((l) => l.kind === 'text');
      if (t && t.kind === 'text') {
        t.text = '长乐';
        t.layout = 'horizontal';
        t.fontSizeMm = 10;
        t.letterSpacingMm = 1.5;
      }
      return spec;
    },
  },
];
