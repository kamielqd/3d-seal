import { traceMask } from './src/geometry/trace.ts';
import { signedArea } from './src/geometry/polygon.ts';
import type { Vec2 } from './src/geometry/types.ts';
const w = 20, h = 20;
const m = new Uint8Array(w*h);
for (let y=5;y<15;y++) for (let x=5;x<15;x++) m[y*w+x]=1;
const loops = traceMask(m,w,h);
console.log('loops', loops.length, 'first', loops[0]?.length, 'area(px)', loops.length? signedArea(loops[0]!.map(([x,y])=>[x,h-y] as Vec2)).toFixed(1):'-');
console.log('outer signed area raw', loops.length? signedArea(loops[0]!).toFixed(1):'-');