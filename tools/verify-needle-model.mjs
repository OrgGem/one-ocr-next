import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {NEEDLE_MODEL} from '../src/needle-extractor.mjs';

const modelPath=resolve(process.argv[2]??'models/needle3.cact');
const info=await stat(modelPath);
if(!info.isFile()||info.size!==NEEDLE_MODEL.bytes)throw new Error(`Needle model size mismatch: ${info.size} bytes`);
const hash=createHash('sha256');
for await(const chunk of createReadStream(modelPath))hash.update(chunk);
const sha256=hash.digest('hex');
if(sha256!==NEEDLE_MODEL.sha256)throw new Error(`Needle model checksum mismatch: ${sha256}`);
process.stdout.write(JSON.stringify({file:NEEDLE_MODEL.file,bytes:info.size,sha256,revision:NEEDLE_MODEL.revision})+'\n');
