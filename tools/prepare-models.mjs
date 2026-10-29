import {readOneModel,sha256} from '../src/onemodel.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const input=process.argv[2],output=resolve(process.argv[3]??'models');
if(!input) {console.error('Usage: node tools/prepare-models.mjs /path/to/oneocr.onemodel [output-directory]');process.exit(2);}
const decoded=await readOneModel(resolve(input));
await mkdir(join(output,'resources'),{recursive:true});
const resources=[];
for(const r of decoded.resources) {
  const ext=r.originalName.toLowerCase().endsWith('.onnx')?'.onnx':'.bin';
  const file=`resources/${String(r.id).padStart(3,'0')}-${r.sha256.slice(0,12)}${ext}`;
  await writeFile(join(output,file),r.bytes);
  resources.push({id:r.id,name:r.originalName,file,bytes:r.bytes.length,sha256:r.sha256});
}
await writeFile(join(output,'config.pb'),decoded.config);
const manifest={schema:'oneocr.models.v1',sourceSha256:decoded.sha256,configSha256:sha256(decoded.config),resources};
await writeFile(join(output,'bundle.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({sourceSha256:decoded.sha256,resourceCount:resources.length,output,models:resources.filter(r=>r.file.endsWith('.onnx')).length}));
