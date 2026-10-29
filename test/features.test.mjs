import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assembleWordFeatures} from '../src/features.mjs';

test('21-feature assembly matches observed native Latin/Arabic words and alternatives',async()=>{
  const corpus=JSON.parse(await readFile(new URL('./corpus/feature-statistics.json',import.meta.url),'utf8'));
  assert.ok(corpus.cases.length>=14);
  let worst=0;
  for(const sample of corpus.cases) {
    const actual=assembleWordFeatures(sample);
    for(let i=0;i<21;i++) {
      const error=Math.abs(actual[i]-sample.expected[i]);worst=Math.max(worst,error);
      assert.ok(error<2e-6,`${sample.text} feature ${i}: ${actual[i]} versus ${sample.expected[i]}`);
    }
  }
  assert.ok(worst<2e-6);
  assert.throws(()=>assembleWordFeatures({text:'x',characters:[],alternatives:[]}),/require/);
});
