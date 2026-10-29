import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import * as ort from 'onnxruntime-node';
import assert from 'node:assert/strict';
import {ModelBundle} from '../src/models.mjs';
import {makePortableOnnx,wireFields,wireMessage} from '../src/onnx-portable.mjs';

const root=resolve(import.meta.dirname,'..');
const native=JSON.parse(await readFile(join(root,'test/corpus/calibration-cases.json'),'utf8'));
const bundle=await ModelBundle.open(join(root,'models'));
const rows=[];
try {
  for(const sample of native.cases) {
    const resource=bundle.resources.find(r=>r.sha256===sample.model_sha256);
    assert.ok(resource,'Native observation must match an exact model digest');
    const portable=makePortableOnnx(await bundle.bytes(resource));
    const fields=wireFields(portable.bytes),graph=fields.find(f=>f.number===7),graphFields=wireFields(graph.value);
    const variable={number:12,wire:2,value:wireMessage([{number:1,wire:2,value:Buffer.from('oneocr_feature')},{number:2,wire:2,value:wireMessage([{number:1,wire:2,value:wireMessage([{number:1,wire:0,value:1n}])}])}])};
    graph.value=wireMessage([...graphFields,variable]);
    const session=await ort.InferenceSession.create(wireMessage(fields),{intraOpNumThreads:2,logSeverityLevel:3});
    try {
      const inputBytes=sample.input.file?await readFile(join(root,'test/corpus',sample.input.file)):null;
      const inputData=inputBytes?Float32Array.from({length:inputBytes.length/4},(_,i)=>inputBytes.readFloatLE(i*4)):Float32Array.from(sample.input.values);
      const actual=await session.run({data:new ort.Tensor('float32',inputData,sample.input.shape)});
      let worst=0;
      for(const [name,expected] of Object.entries(sample.expected)) {
        assert.deepEqual(actual[name].dims,expected.shape);
        for(let i=0;i<expected.values.length;i++)worst=Math.max(worst,Math.abs(actual[name].data[i]-expected.values[i]));
      }
      assert.ok(worst<2e-5,`Portable ${resource.profile}: error ${worst}`);
      rows.push({role:resource.role,profile:resource.profile,maxAbsoluteError:worst});
    } finally {await session.release();}
  }
} finally {await bundle.close();}
assert.equal(rows.length,23);
await mkdir(join(root,'test/results'),{recursive:true});
await writeFile(join(root,`test/results/calibration-parity-${process.platform}.json`),JSON.stringify({platform:process.platform,cases:rows.length,rows},null,2));
console.log(JSON.stringify({cases:rows.length,maxAbsoluteError:Math.max(...rows.map(r=>r.maxAbsoluteError))}));
