import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {OcrEngine} from '../src/index.mjs';
import {evaluate,quad} from './vietnamese-metrics.mjs';

const root=resolve(import.meta.dirname,'..'),corpus=join(root,'test/vietnamese-tables');
const out=process.env.ONEOCR_TEST_OUTPUT?resolve(process.env.ONEOCR_TEST_OUTPUT):join(root,'test/results/vietnamese-tables',`${process.platform}-${process.arch}`);
const bytes=await readFile(join(corpus,'manifest.json'));
const manifest=JSON.parse(bytes),sha=data=>createHash('sha256').update(data).digest('hex');
const oracle=JSON.parse(await readFile(join(corpus,'native-oracle.json'),'utf8'));
assert.equal(oracle.manifestSha256,sha(bytes),'Native oracle is stale; record it again for this manifest');
await mkdir(out,{recursive:true});
const engine=await OcrEngine.create({modelPath:process.env.ONEOCR_MODEL_PATH??join(root,'models')});
const rows=[];
try {
  for(const sample of manifest.samples) {
    const input=await readFile(join(corpus,sample.file));
    assert.equal(sha(input),sample.imageSha256,`Fixture changed: ${sample.id}`);
    const result=await engine.recognize(input,{language:'vi'});
    assert.equal(result.model_sha256,oracle.modelSha256,'Port and native oracle use different models');
    const native=oracle.samples[sample.id];assert.ok(native,`Missing native oracle: ${sample.id}`);
    const portScore=evaluate(sample,result),nativeScore=evaluate(sample,native);
    const row={id:sample.id,tier:sample.tier,description:sample.description,
      port:portScore,native:nativeScore,textMatchesNative:result.text.normalize('NFC')===native.text.normalize('NFC'),elapsedMs:result.elapsed_ms};
    rows.push(row);
    await writeFile(join(out,sample.id+'.json'),JSON.stringify({sample,port:result,native,evaluation:row},null,2));
    console.log(JSON.stringify({id:row.id,tier:row.tier,passed:portScore.passed,
      cells:`${portScore.exactCells}/${portScore.totalCells}`,numeric:`${portScore.exactNumericCells}/${portScore.numericCells}`,
      cellCER:portScore.cellCharacterErrorRate,nativeCells:`${nativeScore.exactCells}/${nativeScore.totalCells}`,
      readingOrder:portScore.readingOrderExact,geometry:portScore.geometryValid}));
    row.imageData='data:image/png;base64,'+input.toString('base64');
    row.overlays={port:result.lines.flatMap(l=>l.words.map(w=>({text:w.text,points:quad(w.bounding_rect)}))),
      native:native.lines.flatMap(l=>l.words.map(w=>({text:w.text,points:quad(w.bounding_rect)})))};
  }
} finally {await engine.close();}

const summarize=tier=>{
  const selected=rows.filter(r=>r.tier===tier);
  return Object.fromEntries(['port','native'].map(key=>[key,{
    passed:selected.filter(r=>r[key].passed).length,total:selected.length,
    exactCells:selected.reduce((n,r)=>n+r[key].exactCells,0),totalCells:selected.reduce((n,r)=>n+r[key].totalCells,0),
    exactNumericCells:selected.reduce((n,r)=>n+r[key].exactNumericCells,0),numericCells:selected.reduce((n,r)=>n+r[key].numericCells,0),
    cellCharacterErrorRate:selected.reduce((n,r)=>n+r[key].cellCharacterEdits,0)/Math.max(1,selected.reduce((n,r)=>n+r[key].cellCharacters,0))
  }]));
};
const required=summarize('required'),stress=summarize('stress');
const passed=required.port.passed===required.port.total;
const report={status:passed?'passed':'failed',generatedAt:new Date().toISOString(),scope:manifest.scope,policy:manifest.policy,
  platform:process.platform,architecture:process.arch,node:process.version,manifestSha256:sha(bytes),modelSha256:oracle.modelSha256,
  sourceSha256:Object.fromEntries(await Promise.all((await readdir(join(root,'src'))).sort().map(async name=>[name,sha(await readFile(join(root,'src',name)))]))),
  required,stress,textMatchesNative:rows.filter(r=>r.textMatchesNative).length,samples:rows.length,
  rows:rows.map(({imageData,overlays,...row})=>row)};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));

const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const percent=n=>(n*100).toFixed(2)+'%';
const overlay=(sample,row,key)=>`<svg viewBox="0 0 ${sample.width} ${sample.height}" role="img" aria-label="${esc(row.id)} ${key}"><image width="${sample.width}" height="${sample.height}" href="${row.imageData}"/>${sample.cells.map(c=>`<polygon points="${c.polygon.map(p=>p.join(',')).join(' ')}" fill="none" stroke="#d97706" stroke-width="2"><title>GT ${esc(c.id+': '+c.text)}</title></polygon>`).join('')}${row.overlays[key].map(w=>`<polygon points="${w.points.map(p=>p.join(',')).join(' ')}" fill="#06b6d410" stroke="#0891b2" stroke-width="1.5"><title>${esc(w.text)}</title></polygon>`).join('')}</svg>`;
const html=`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kiểm thử OCR tiếng Việt và bảng biểu</title><style>body{font:16px system-ui;max-width:1440px;margin:24px auto;padding:0 20px;color:#18222d}h1{font-size:28px}h2{margin-top:40px}.bad{color:#b42318}.ok{color:#067647}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #ccd4dc;padding:8px;text-align:left;vertical-align:top}tr.fail{background:#fff1ee}.images{display:grid;grid-template-columns:1fr 1fr;gap:16px}svg{width:100%;border:1px solid #dde3e9}pre{white-space:pre-wrap}summary{cursor:pointer}small{color:#52616f}@media(max-width:800px){.images{grid-template-columns:1fr}}</style><h1>OCR tiếng Việt và bảng biểu</h1><p class="${passed?'ok':'bad'}">Linux acceptance: ${passed?'PASS':'FAIL'} — ${required.port.passed}/${required.port.total} ca bắt buộc, ${stress.port.passed}/${stress.port.total} ca thử giới hạn.</p><p>Đáp án được viết khi dựng ảnh, độc lập với OCR. Giữ nguyên dấu, chữ hoa và dấu phân cách số; chỉ chuẩn hóa NFC và khoảng trắng. Ô đúng khi nhận đủ, đúng thứ tự mọi từ và tâm bounding box nằm trong ô chuẩn. Hình cam: ô chuẩn. Hình xanh: từ OCR (di chuột để đọc).</p><p>Đây là ảnh tổng hợp có chữ in. Chưa đánh giá ảnh scan thực tế, chữ viết tay hay khôi phục cấu trúc bảng thành Excel/HTML.</p><p><small>${esc(report.platform+' '+report.architecture+' / '+report.node)} · Model SHA-256 ${esc(report.modelSha256)} · ${esc(report.generatedAt)}</small></p><table><thead><tr><th>Ảnh</th><th>Nhóm</th><th>Port: ô đúng</th><th>Native: ô đúng</th><th>Port CER theo ô</th><th>Thứ tự / bbox</th></tr></thead><tbody>${rows.map(r=>`<tr class="${r.port.passed?'':'fail'}"><td><a href="#${esc(r.id)}">${esc(r.id)}</a></td><td>${r.tier}</td><td>${r.port.exactCells}/${r.port.totalCells}</td><td>${r.native.exactCells}/${r.native.totalCells}</td><td>${percent(r.port.cellCharacterErrorRate)}</td><td>${r.port.readingOrderExact?'đúng':'sai'} / ${r.port.geometryValid?'hợp lệ':'lỗi'}</td></tr>`).join('')}</tbody></table>${rows.map((r,i)=>`<section id="${esc(r.id)}"><h2>${esc(r.id)}</h2><p>${esc(r.description)}</p><div class="images"><div><h3>Port Node.js / ${esc(process.platform)}</h3>${overlay(manifest.samples[i],r,'port')}</div><div><h3>Engine Windows gốc (baseline)</h3>${overlay(manifest.samples[i],r,'native')}</div></div><details ${r.port.passed?'':'open'}><summary>Nội dung từng ô và lỗi</summary><table><thead><tr><th>Ô</th><th>Đáp án</th><th>Port</th><th>Native</th></tr></thead><tbody>${r.port.cells.map((c,j)=>`<tr class="${c.exact?'':'fail'}"><td>${esc(c.id)}</td><td>${esc(c.expected)}</td><td>${esc(c.actual)||'<em>trống</em>'}</td><td>${esc(r.native.cells[j].actual)||'<em>trống</em>'}</td></tr>`).join('')}</tbody></table><p>Từ không gán được vào ô: ${esc(JSON.stringify(r.port.unassigned))}</p><p>Lỗi bounding box: ${esc(JSON.stringify(r.port.invalidGeometry))}</p></details></section>`).join('')}</html>`;
await writeFile(join(out,'report.html'),html);
console.log(JSON.stringify({status:report.status,required,stress,report:join(out,'report.html')}));
if(!passed)process.exitCode=1;
