param([string]$Image='oneocr-next:local')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$containerId=$null
try {
  $containerId=(& docker run --rm -d -p '127.0.0.1::8001' $Image).Trim()
  if($LASTEXITCODE -ne 0 -or $containerId -notmatch '^[a-f0-9]{64}$'){throw 'Unable to create verification container'}
  $portInfo=(& docker port $containerId '8001/tcp').Trim()
  $origin='http://'+$portInfo
  $health=$null
  for($attempt=0;$attempt -lt 20;$attempt++) {
    try {$health=Invoke-RestMethod ($origin+'/health') -TimeoutSec 2;break} catch {Start-Sleep -Milliseconds 250}
  }
  if($health.platform -ne 'linux' -or $health.status -ne 'ready'){throw 'Linux image health failed'}
  $fixtureImage=Join-Path $projectRoot 'test/corpus/fixtures/vietnamese.png'
  $result=Invoke-RestMethod ($origin+'/api/v1/ocr?language=vi') -Method Post -ContentType 'image/png' -InFile $fixtureImage
  if($result.text -ne "Tiếng Việt có dấu`nHóa đơn tổng cộng 123.45"){throw 'Packaged image OCR mismatch'}
  if($result.provenance.confidence -ne 'original-model-reconstructed-features' -or $result.provenance.decoder -ne 'reconstructed-native-lattice-20-best'){throw 'Packaged image does not contain the verified native-model pipeline'}
  if(-not $result.lines[0].rejection.accepted){throw 'Packaged image did not run rejection successfully'}
  $modelCount=& docker exec $containerId node --input-type=module -e 'import {ModelBundle} from "./src/models.mjs";const b=await ModelBundle.open(process.env.ONEOCR_MODEL_PATH);try{const models=b.resources.filter(r=>r.basename.endsWith(".onnx"));for(const model of models)await b.session(model);console.log(models.length)}finally{await b.close()}'
  if($LASTEXITCODE -ne 0 -or $modelCount.Trim() -ne '34'){throw 'Packaged image could not load all original models'}
  $dllCount=& docker exec $containerId node --input-type=module -e 'import {readdir} from "node:fs/promises";import {join} from "node:path";let n=0;async function walk(p){for(const x of await readdir(p,{withFileTypes:true})){const q=join(p,x.name);if(x.isDirectory())await walk(q);else if(/\.dll$/i.test(q))n++}}await walk("/app");console.log(n);'
  if($LASTEXITCODE -ne 0 -or $dllCount.Trim() -ne '0'){throw 'Packaged image contains unexpected Windows DLLs'}
  & docker exec $containerId node -e 'fetch("http://127.0.0.1:8001/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
  if($LASTEXITCODE -ne 0){throw 'Image healthcheck command failed'}
  $imageInfo=(& docker image inspect $Image | ConvertFrom-Json)[0]
  $mountCount=[int](& docker inspect $containerId --format '{{len .Mounts}}')
  if($mountCount -ne 0){throw 'Verification container must run without any mounts'}
  $report=@{status='passed';verifiedAt=[DateTime]::UtcNow.ToString('o');imageId=$imageInfo.Id;os=$imageInfo.Os;architecture=$imageInfo.Architecture;user=$imageInfo.Config.User;health=$health;text=$result.text;confidenceMethod=$result.provenance.confidence;decoder=$result.provenance.decoder;modelsLoaded=[int]$modelCount;windowsDllCount=[int]$dllCount;mountCount=$mountCount;modelBundled=$true;containerStoppedAfterVerification=$true}
  $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $projectRoot 'docs/evidence/docker-verification.json')
  $report | ConvertTo-Json -Depth 8
} finally {
  if($containerId -match '^[a-f0-9]{64}$'){ & docker stop -t 10 $containerId | Out-Null }
}
