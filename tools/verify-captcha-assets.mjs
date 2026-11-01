import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';

const assets=[
  {name:'common_old.onnx',bytes:13_606_051,sha256:'b8f2ad9cbc1f2e3922a6cb9459e30824e7e2467f3fb4fd61420640e34ea0bf68'},
  {name:'common_old-charset.json',bytes:57_249,sha256:'342d871c34fd467420cd39b58a4624b505da53114e77a69b43b48b8a3ee1b24d'},
];
const directory=process.argv[2]??'models';
for(const asset of assets){
  const path=join(directory,asset.name),info=await stat(path);
  if(!info.isFile()||info.size!==asset.bytes)throw new Error(`${asset.name}: unexpected asset size`);
  const bytes=await readFile(path),actual=createHash('sha256').update(bytes).digest('hex');
  if(actual!==asset.sha256)throw new Error(`${asset.name}: SHA-256 mismatch`);
  if(asset.name.endsWith('.json')){
    const charset=JSON.parse(bytes.toString('utf8'));
    if(!Array.isArray(charset)||charset.length!==8210||charset[0]!==''||new Set(charset).size!==8210||charset.slice(1).some(token=>typeof token!=='string'||Array.from(token).length!==1))throw new Error('common_old-charset.json: invalid charset contract');
  }
  console.log(`${asset.name}: verified ${asset.bytes} bytes sha256:${actual}`);
}