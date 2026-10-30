// Scan exactly what is staged; never print credentials or matching content.
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';

const names=execFileSync('git',['diff','--cached','--name-only','--diff-filter=ACM','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
let localKey;
try{localKey=(await readFile('.env','utf8')).match(/^ONEOCR_API_KEY=(.+)$/m)?.[1].trim();}catch{}
const findings=[];
const credentialPatterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/gh[pousr]_[A-Za-z0-9]{30,}/,/github_pat_[A-Za-z0-9_]{40,}/,/AKIA[A-Z0-9]{16}/];
let textFiles=0,binaryFiles=0;
for(const path of names) {
  if(/(?:^|\/)(?:node_modules|\.local|work)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/.test(path)&&path!=='.env.example')findings.push({path,rule:'private/local path'});
  if(/\.(?:dll|pem|key)$/i.test(path))findings.push({path,rule:'private/native artifact'});
  if(/\.onemodel$/i.test(path)&&path!=='models/oneocr.onemodel')findings.push({path,rule:'unexpected model asset'});
  if(/\.(?:bin|cact|onnx|png|f32|onemodel)$/i.test(path)){binaryFiles++;continue;}
  textFiles++;
  const content=execFileSync('git',['show',':'+path],{encoding:'utf8',maxBuffer:16*1024*1024});
  if(credentialPatterns.some(pattern=>pattern.test(content)))findings.push({path,rule:'credential pattern'});
  if(localKey&&content.includes(localKey))findings.push({path,rule:'local service key'});
}
console.log(JSON.stringify({status:findings.length?'failed':'passed',stagedFiles:names.length,textFiles,binaryFiles,findings},null,2));
if(findings.length)process.exitCode=1;
