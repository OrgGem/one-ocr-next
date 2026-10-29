// Native word statistics -> reconstructed 21 features -> portable confidence
// model -> original GetOcrWordConfidence. Decoder generation is a separate gap.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {ModelBundle,assembleWordFeatures} from '../src/index.mjs';
import {logicalRtl} from '../src/recognizer.mjs';
const root=new URL('../',import.meta.url);
const corpus=JSON.parse(await readFile(new URL('test/corpus/feature-statistics.json',root),'utf8'));
const oracle=JSON.parse(await readFile(new URL('test/corpus/native-oracle.json',root),'utf8'));
const bundle=await ModelBundle.open(fileURLToPath(new URL('models/',root)));
const rows=[];
try {
  for(const sample of corpus.cases) {
    const arabic=sample.sourceImage==='arabic.png',profile=arabic?'ArabicMixedDummy':'LatinPrintedV2Dummy';
    const text=logicalRtl(sample.text,arabic?'arabic':'latin').toLocaleLowerCase('und');
    const native=oracle.samples[sample.sourceImage].lines.flatMap(l=>l.words).filter(w=>w.text.toLocaleLowerCase('und')===text);
    assert.equal(native.length,1,`Unique original word observation required for ${text}`);
    const result=await bundle.evaluateFeatures('Confidence',profile,assembleWordFeatures(sample));
    const actual=result.softmax.values[1],error=Math.abs(actual-native[0].confidence);
    assert.ok(error<2e-5,`${sample.text}: ${actual} versus native ${native[0].confidence}`);
    rows.push({word:sample.text,profile,original:native[0].confidence,portable:actual,maxAbsoluteError:error});
  }
} finally {await bundle.close();}
await mkdir(new URL('test/results/',root),{recursive:true});
await writeFile(new URL(`test/results/native-confidence-parity-${process.platform}.json`,root),JSON.stringify({scope:'recorded native intermediate inputs; decoder input generation not validated',cases:rows.length,rows},null,2));
console.log(JSON.stringify({cases:rows.length,maxAbsoluteError:Math.max(...rows.map(r=>r.maxAbsoluteError))}));
