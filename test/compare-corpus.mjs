import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {OcrEngine} from '../src/index.mjs';

const root=resolve(import.meta.dirname,'..');
const oracle=JSON.parse(await readFile(join(root,'test/corpus/native-oracle.json'),'utf8'));
const engine=await OcrEngine.create({modelPath:process.env.ONEOCR_MODEL_PATH??join(root,'models')});
const rows=[];
try {
  for(const [file,original] of Object.entries(oracle.samples)) {
    const result=await engine.recognize(join(root,'test/corpus/fixtures',file));
    const angleError=Math.abs(((result.text_angle-original.text_angle+540)%360)-180);
    const wordSequenceExact=JSON.stringify(result.lines.map(l=>l.words.map(w=>w.text)))===JSON.stringify(original.lines.map(l=>l.words.map(w=>w.text)));
    const row={file,exactText:result.text.normalize('NFC')===original.text.normalize('NFC'),wordSequenceExact,nativeText:original.text,text:result.text,nativeLines:original.lines.length,lines:result.lines.length,angleError,elapsedMs:result.elapsed_ms};
    rows.push(row);console.log(JSON.stringify(row));
    await mkdir(join(root,'test/results'),{recursive:true});
    await writeFile(join(root,'test/results',file+'.json'),JSON.stringify(result,null,2));
  }
} finally {await engine.close();}
const report={status:rows.every(r=>r.exactText&&r.wordSequenceExact)?'text-and-word-sequence-match':'partial-parity',scope:'synthetic-development-corpus; confidence and exact geometry not validated',platform:process.platform,architecture:process.arch,node:process.version,sourceModelSha256:oracle.model_sha256,exactTextMatches:rows.filter(r=>r.exactText).length,exactWordSequenceMatches:rows.filter(r=>r.wordSequenceExact).length,samples:rows.length,rows};
await mkdir(join(root,'test/results'),{recursive:true});
await writeFile(join(root,`test/results/comparison-${process.platform}.json`),JSON.stringify(report,null,2));
console.log(JSON.stringify({exactTextMatches:report.exactTextMatches,samples:rows.length}));
