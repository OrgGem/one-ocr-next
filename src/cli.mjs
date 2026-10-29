#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
import {OcrEngine} from './index.mjs';
import {readOneModel} from './onemodel.mjs';

const args=process.argv.slice(2),command=args.shift();
const takeOption=(name,fallback)=>{const index=args.indexOf(name);if(index<0)return fallback;if(index+1>=args.length)throw new Error(`Missing value for ${name}`);const result=args[index+1];args.splice(index,2);return result;};
try {
  if(!command||['--help','help','-h'].includes(command)) {
    console.log('oneocr-native recognize IMAGE [--models DIR_OR_ONEMODEL] [--language vi] [--max-lines 1000] [--threads 2] [--text] [--output FILE]\noneocr-native inspect-model ONEOCR.onemodel\noneocr-native serve [--models DIR_OR_ONEMODEL] [--host 127.0.0.1] [--port 8001]');
  } else if(command==='recognize') {
    const modelPath=takeOption('--models',process.env.ONEOCR_MODEL_PATH??'models');
    const language=takeOption('--language',null),maxLines=Number(takeOption('--max-lines','1000')),threads=Number(takeOption('--threads','2'));
    const output=takeOption('--output',null),textOnly=args.includes('--text');if(textOnly)args.splice(args.indexOf('--text'),1);
    const file=args.shift();if(!file||args.length)throw new Error('Supply exactly one image path; use --help for options');
    const engine=await OcrEngine.create({modelPath,threads});
    try {
      const result=await engine.recognize(file,{language,maxLines});const content=textOnly?result.text+'\n':JSON.stringify(result,null,2)+'\n';
      if(output)await writeFile(output,content);else process.stdout.write(content);
    } finally {await engine.close();}
  } else if(command==='inspect-model') {
    if(args.length!==1)throw new Error('Supply one .onemodel file');
    const model=await readOneModel(args[0]);
    console.log(JSON.stringify({sha256:model.sha256,resources:model.resources.map(r=>({name:r.originalName,bytes:r.bytes.length,sha256:r.sha256}))},null,2));
  } else if(command==='serve') {
    const modelPath=takeOption('--models',process.env.ONEOCR_MODEL_PATH??'models');
    const host=takeOption('--host',process.env.ONEOCR_HOST??'127.0.0.1'),port=Number(takeOption('--port',process.env.ONEOCR_PORT??'8001'));
    if(args.length)throw new Error('Unknown serve options');
    const {serve}=await import('./server.mjs');const app=await serve({modelPath,host,port});
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;await app.close();};process.on('SIGINT',stop);process.on('SIGTERM',stop);
  } else throw new Error(`Unknown command: ${command}`);
} catch(error) {console.error(JSON.stringify({error:error.message}));process.exitCode=1;}
