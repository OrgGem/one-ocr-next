import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {ModelBundle} from '../src/models.mjs';
import {buildLattice,latticeAlternatives,characterStatistics} from '../src/lattice.mjs';
import {assembleWordFeatures} from '../src/features.mjs';
import {logicalRtl} from '../src/recognizer.mjs';
const root=new URL('../',import.meta.url),bundle=await ModelBundle.open(fileURLToPath(new URL('models/',root)));
const reports=[];
try {
  for(const script of (process.argv.length>2?process.argv.slice(2):['latin','arabic','cjk','thai','cyrillic','greek','hebrew','tamil'])) {
    const trace=JSON.parse(await readFile(new URL(`docs/evidence/features-${script}.json`,root),'utf8'));
    const observations=trace.messages.map(m=>m.payload).filter(Boolean),encoding=await bundle.encoding(script),lattices=[];
    let maxScoreError=0,maxFeatureError=0,words=0,frames=0;const decodedLines=[];
    for(const input of observations.filter(v=>v.kind==='recognizer-logits')) {
      const bytes=await readFile(new URL('docs/evidence/'+input.file,root)),data=Float32Array.from({length:bytes.length/4},(_,i)=>bytes.readFloatLE(i*4));
      const lattice=buildLattice({dims:input.shape,data},encoding);
      const native=observations.find(v=>v.kind==='word-lattice'&&v.frames===lattice.time);
      assert.ok(native,`${script} exact frame count`);assert.deepEqual(Array.from(lattice.offsets),native.offsets,`${script} offsets`);assert.deepEqual(Array.from(lattice.labels),native.labels,`${script} labels`);
      for(let i=0;i<native.scores.length;i++)maxScoreError=Math.max(maxScoreError,Math.abs(lattice.scores[i]-native.scores[i]));
      assert.ok(maxScoreError<2e-5,`${script} lattice score ${maxScoreError}`);lattices.push(lattice);frames+=lattice.time;
      decodedLines.push(logicalRtl(lattice.text.trim(),script));
    }
    for(const sample of observations.filter(v=>v.kind==='feature-characters'&&v.features)) {
      const average=(lattice,c)=>{
        const sum={posterior:0,blank:0,space:0,competitor:0},count=c.integers[3]-c.integers[2]+1;
        for(let frame=c.integers[2];frame<=c.integers[3];frame++){const stats=characterStatistics(lattice,encoding,frame,c.character.id);for(const key of Object.keys(sum))sum[key]=Math.fround(sum[key]+stats[key]);}
        return Object.fromEntries(Object.entries(sum).map(([key,value])=>[key,Math.fround(value/count)]));
      };
      const matching=lattices.filter(lattice=>sample.endFrame<lattice.time&&sample.chars.every(c=>Math.abs(average(lattice,c).posterior-c.floats[0])<2e-5));
      assert.equal(matching.length,1,`${script} unique observed character/frame pairing for ${sample.word}`);
      const lattice=matching[0],alternatives=latticeAlternatives(lattice,encoding,sample.startFrame,sample.endFrame);
      assert.deepEqual(alternatives.map(a=>a.text),sample.alternatives.map(a=>a.text),`${script} alternatives ${sample.word}`);
      for(let i=0;i<alternatives.length;i++)assert.ok(Math.abs(alternatives[i].score-sample.alternatives[i].score)<2e-5,`${script} acoustic score ${sample.word}: ${alternatives[i].score} != ${sample.alternatives[i].score}`);
      const characters=sample.chars.map(c=>({...average(lattice,c),character:c.character,rawCharacter:c.rawCharacter,firstFrame:c.integers[2],lastFrame:c.integers[3]}));
      const features=assembleWordFeatures({text:sample.word,characters,alternatives});
      for(let i=0;i<21;i++)maxFeatureError=Math.max(maxFeatureError,Math.abs(features[i]-sample.features[i]));
      assert.ok(maxFeatureError<2e-5,`${script} feature error ${maxFeatureError}`);words++;
    }
    assert.deepEqual(decodedLines.sort(),trace.native_text.split('\n').sort(),`${script} original-logit line text`);
    reports.push({script,frames,words,maxScoreError,maxFeatureError,lineTextMatches:decodedLines.length});
  }
} finally {await bundle.close();}
await mkdir(new URL('test/results/',root),{recursive:true});
await writeFile(new URL(`test/results/lattice-parity-${process.platform}.json`,root),JSON.stringify({scope:'native recognizer logits -> sparse lattice -> recorded word spans -> alternatives and 21 features',reports},null,2));
console.log(JSON.stringify({reports}));
