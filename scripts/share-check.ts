import { createDefaultSpec } from '../src/core/spec.ts';
import { encodeSpecForUrl, decodeSpecFromQuery } from '../src/core/share.ts';
const spec = createDefaultSpec();
const { query, droppedImages } = encodeSpecForUrl(spec);
const back = decodeSpecFromQuery('?' + query);
console.log('query len =', query.length, ' droppedImages =', droppedImages);
console.log('roundtrip ok =', !!back && back.body.shape === spec.body.shape && back.layers.length === spec.layers.length);
console.log('text preserved =', back?.layers[0]?.kind === 'text' && back.layers[0].text === '印章工坊');
