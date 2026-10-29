// The ORT npm archive ships binaries for multiple systems. Keep only the
// current Linux container's platform/architecture in the produced image.
import {readdir,rm} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
if(process.platform!=='linux'||process.cwd()!=='/app')throw new Error('This packaging helper runs only in the /app Linux build container');
const root=resolve('/app/node_modules/onnxruntime-node/bin/napi-v6');
async function removeChild(parent,name) {
  const target=resolve(parent,name);
  if(!target.startsWith(root+sep))throw new Error('Runtime pruning path escaped the package directory');
  await rm(target,{recursive:true});
}
for(const platform of await readdir(root,{withFileTypes:true})) {
  if(!platform.isDirectory())continue;
  if(platform.name!=='linux')await removeChild(root,platform.name);
  else for(const architecture of await readdir(resolve(root,'linux'),{withFileTypes:true})) {
    if(architecture.isDirectory()&&architecture.name!==process.arch)await removeChild(resolve(root,'linux'),architecture.name);
  }
}
