import {ModelBundle,CLASSIFIER_SCRIPTS} from '../src/models.mjs';
import {makePortableOnnx} from '../src/onnx-portable.mjs';
import {sha256} from '../src/onemodel.mjs';
import {writeFile} from 'node:fs/promises';
const bundle=await ModelBundle.open(process.argv[2]??'models');
try {
  const models=[];
  for(const resource of bundle.resources.filter(r=>r.basename.endsWith('.onnx'))) {
    const original=await bundle.bytes(resource),portable=makePortableOnnx(original);
    models.push({role:resource.role,profile:resource.profile,sha256:resource.sha256,bytes:original.length,convertedFeatureBlocks:portable.converted});
  }
  const scripts=[];
  for(const [script,entry]of bundle.characters) {
    const vocabulary=await bundle.alphabet(script);
    scripts.push({script,profile:entry.model.profile,pixelsPerFrame:entry.pixelsPerFrame,vocabularySize:vocabulary.alphabet.length,blank:vocabulary.blank});
  }
  const report={sourceModelSha256:bundle.sourceSha256,configSha256:sha256(bundle.config),resources:bundle.resources.length,models:models.length,convertedFeatureBlocks:models.reduce((n,m)=>n+m.convertedFeatureBlocks,0),classifierScripts:CLASSIFIER_SCRIPTS,detectorOptions:bundle.detectorOptions,scripts,modelInventory:models};
  await writeFile(process.argv[3]??'docs/evidence/model-inventory.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({resources:report.resources,models:report.models,convertedFeatureBlocks:report.convertedFeatureBlocks}));
} finally {await bundle.close();}
