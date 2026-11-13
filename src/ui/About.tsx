/**
 * 字体与授权页。
 *
 * 这不是「可选的好看页面」，是上线前的法律闸门：
 *  - OFL-1.1 要求随分发附带授权文本；
 *  - 全字库说文解字是《政府资料开放授权条款》第 1 版，**要求署名**；
 *  - 排除了 CC BY-ND 的字体（禁改作，子集化有风险），这里不列。
 *
 * 每个字体都能点开随包的授权原文，链接按 BASE_URL 拼，GitHub Pages 子路径下也能打开。
 */

const base = (): string => {
  const b = import.meta.env.BASE_URL ?? './';
  return b.endsWith('/') ? b : b + '/';
};

interface FontLicense {
  name: string;
  license: string;
  /** 授权原文（相对 BASE_URL 的 public 路径） */
  textPath: string;
  /** 上游项目地址 */
  homepage?: string;
  note: string;
}

const FONTS: FontLicense[] = [
  {
    name: '得意黑 Smiley Sans',
    license: 'SIL Open Font License 1.1',
    textPath: 'fonts/smiley-sans/OFL.txt',
    homepage: 'https://github.com/atelier-anchor/smiley-sans',
    note: '默认字体；子集到 GB2312 一级 3755 字 + ASCII + 标点。',
  },
  {
    name: '霞鹜文楷 LXGW WenKai',
    license: 'SIL Open Font License 1.1',
    textPath: 'fonts/lxgw-wenkai/OFL.txt',
    homepage: 'https://github.com/lxgw/LxgwWenKai',
    note: '子集 3755 字；楷体轮廓点较多，包体 1.74MB，按需加载。',
  },
  {
    name: '霞鹜篆书 LxgwSeal',
    license: 'SIL Open Font License 1.1',
    textPath: 'fonts/lxgw-seal/OFL.txt',
    homepage: 'https://github.com/lxgw/LxgwSeal',
    note: '标准小篆，目前仅 75 个主题字（福禄寿喜等），不能覆盖任意人名。',
  },
  {
    name: '思源黑体 Source Han Sans CN',
    license: 'SIL Open Font License 1.1',
    textPath: 'fonts/source-han-sans/OFL.txt',
    homepage: 'https://github.com/adobe-fonts/source-han-sans',
    note: 'SubsetOTF/CN Regular 源（8.43MB）子集到 3755 字，0.94MB，CFF/OTF。',
  },
  {
    name: '全字库说文解字（小篆）',
    license: '政府资料开放授权条款 第 1 版（OGDL v1）',
    textPath: 'fonts/shuowen/SOURCE.txt',
    homepage: 'https://www.cns11643.gov.tw/',
    note: '6750 字形，授权要求**署名**，详见授权原文与来源说明。含简体别名码位，按字频分两块懒加载。',
  },
];

const LIBS = [
  { name: 'manifold-3d', license: 'Apache-2.0', note: '布尔内核（WASM），保证输出封闭流形' },
  { name: 'three.js', license: 'MIT', note: '3D 预览' },
  { name: 'opentype.js', license: 'MIT', note: '字形解析与轮廓提取' },
  { name: 'fflate', license: 'MIT', note: '3MF 打包（zip 压缩）' },
  { name: 'React', license: 'MIT', note: '界面' },
];

export default function About({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = FONTS.map((f) => [f.name, f.license]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(30,26,22,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 10,
          maxWidth: 720,
          width: '100%',
          maxHeight: '86vh',
          overflowY: 'auto',
          padding: '22px 24px',
          boxShadow: '0 18px 50px rgba(0,0,0,0.22)',
          lineHeight: 1.6,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ fontSize: 17, margin: 0 }}>字体与授权</h2>
          <button
            onClick={onClose}
            style={{ border: '1px solid #ddd7cc', background: '#fff', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}
          >
            关闭
          </button>
        </div>

        <p style={{ fontSize: 12, color: '#7a746b', marginTop: 8 }}>
          本站所有字体都随页面分发到你的浏览器，因此必须遵守各自授权。下面每个字体都附授权原文链接。
          CC BY-ND 一类的「禁改作」字体已被排除——子集化属于改作，不能随站分发。
        </p>

        <h3 style={{ fontSize: 13, margin: '16px 0 6px' }}>内置字体</h3>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <tbody>
            {FONTS.map((f) => (
              <tr key={f.name} style={{ borderTop: '1px solid #efeae1', verticalAlign: 'top' }}>
                <td style={{ padding: '8px 8px 8px 0', width: 170 }}>
                  <strong>{f.name}</strong>
                </td>
                <td style={{ padding: '8px 8px 8px 0' }}>
                  <div>{f.license}</div>
                  <div style={{ color: '#7a746b', marginTop: 2 }}>{f.note}</div>
                  <div style={{ marginTop: 4, display: 'flex', gap: 10 }}>
                    <a href={`${base()}${f.textPath}`} target="_blank" rel="noreferrer">
                      授权原文
                    </a>
                    {f.homepage && (
                      <a href={f.homepage} target="_blank" rel="noreferrer">
                        上游项目
                      </a>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ fontSize: 13, margin: '18px 0 6px' }}>依赖库</h3>
        <div style={{ fontSize: 12, color: '#5a5348' }}>
          {LIBS.map((l) => (
            <div key={l.name}>
              <strong>{l.name}</strong>（{l.license}）—— {l.note}
            </div>
          ))}
        </div>

        <h3 style={{ fontSize: 13, margin: '18px 0 6px' }}>隐私</h3>
        <p style={{ fontSize: 12, color: '#5a5348', margin: 0 }}>
          没有后端。你输入的文字、导入的图片全部只在浏览器内存里处理，不上传任何服务器。
          参数可以生成分享链接，但那只是 URL 里的参数，图片像素不会进链接。
        </p>

        <h3 style={{ fontSize: 13, margin: '18px 0 6px' }}>关于这些字体的取舍</h3>
        <p style={{ fontSize: 12, color: '#5a5348', margin: 0 }}>
          「免费商用」不等于「可以嵌入分发」。站酷、阿里普惠、OPPO Sans 这类字体未明确授予字体重分发与网页嵌入权，
          所以没有打包进来。篆书的覆盖率也不理想：说文在常用 3500 字里能渲染 2596 个，
          缺的字会在输入框标出来，而不是悄悄换成别的字体混排。
        </p>

        <p style={{ fontSize: 11, color: '#a39c91', marginTop: 18, marginBottom: 0 }}>
          代码授权由仓库作者决定，本项目页面不代其声明。
          {rows.length > 0 ? '' : ''}
        </p>
      </div>
    </div>
  );
}
