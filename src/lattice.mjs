// Sparse frame lattice and 20-best individual paths recovered from native
// observations and REA/Ghidra. Path mass is merged only after CTC collapse.
const f=Math.fround;
const logAdd=(a,b)=>a===-Infinity?b:b===-Infinity?a:f(Math.max(a,b)+Math.log1p(Math.exp(-Math.abs(a-b))));

export function buildLattice(logits,encoding) {
  const [time,batch,vocab]=logits.dims;
  if(batch!==1||vocab!==encoding.alphabet.length)throw new Error('Lattice/alphabet mismatch');
  const rawCutoff=Math.log(encoding.options?.rawThreshold??.0001),arcCutoff=Math.log(encoding.options?.arcThreshold??.05),blankCutoff=Math.log(encoding.options?.blankThreshold??.99);
  const offsets=[0],labels=[],scores=[],bestIds=new Int32Array(time),frameStats=[],distributions=[];
  const runs=[];let previous=-1,blankStart=-1,previousBest=encoding.blank;
  for(let t=0;t<time;t++) {
    const groups=new Map();
    for(let id=0;id<vocab;id++) {
      const score=logits.data[t*vocab+id];
      if(score<rawCutoff)continue;
      const canonical=encoding.foldedIds[id],old=groups.get(canonical);
      if(old){old.score=logAdd(old.score,score);if(score>old.sensitiveScore){old.sensitiveId=id;old.sensitiveScore=score;}}
      else groups.set(canonical,{id:canonical,score,sensitiveId:id,sensitiveScore:score});
    }
    if(!groups.size)groups.set(encoding.blank,{id:encoding.blank,score:0,sensitiveId:encoding.blank,sensitiveScore:0});
    if(groups.size>(encoding.options?.maxClasses??30)) {
      const threshold=[...groups.values()].map(g=>g.score).sort((a,b)=>b-a)[(encoding.options?.maxClasses??30)-1];
      for(const [id,group] of groups)if(group.score<threshold)groups.delete(id);
    }
    const ordered=[...groups.values()].sort((a,b)=>a.id-b.id);
    distributions.push(groups);
    let best=ordered[0];for(const group of ordered)if(group.score>best.score)best=group;
    bestIds[t]=best.id;
    let arcs=ordered.filter(group=>group.score>arcCutoff);
    const blankScore=groups.get(encoding.blank)?.score??-Infinity;
    if(blankScore<=blankCutoff){blankStart=-1;previousBest=best.id;}
    else {
      if(blankStart<0) {
        if(previousBest===encoding.blank||(groups.get(previousBest)?.score??-Infinity)<=rawCutoff)blankStart=t;
        else previousBest=best.id;
      }
      arcs=blankStart<0||blankStart===t?[{id:encoding.blank,score:0}]:[];
    }
    for(const arc of arcs){labels.push(arc.id);scores.push(arc.score);}offsets.push(labels.length);
    let competitor=-Infinity;
    for(const group of ordered)if(group.id!==best.id)competitor=Math.max(competitor,group.score);
    const stats={posterior:f(Math.exp(best.score)),blank:groups.has(encoding.blank)?f(Math.exp(groups.get(encoding.blank).score)):0,space:groups.has(encoding.space)?f(Math.exp(groups.get(encoding.space).score)):0,competitor:competitor===-Infinity?0:f(Math.exp(competitor))};
    frameStats.push(stats);
    if(best.id!==encoding.blank) {
      if(best.id===previous) {
        const run=runs.at(-1);run.end=t+1;run.logSum+=best.score;run.frames++;
        for(const key of Object.keys(stats))run.statisticSums[key]=f(run.statisticSums[key]+stats[key]);
        if(best.score>run.peakLog){run.peak=t;run.peakLog=best.score;run.char=encoding.alphabet[best.sensitiveId];}
      } else runs.push({id:best.id,char:encoding.alphabet[best.sensitiveId],physicalChar:encoding.rawAlphabet[best.id],start:t,end:t+1,peak:t,peakLog:best.score,statisticSums:{...stats},logSum:best.score,frames:1});
    }
    previous=best.id;
  }
  for(const run of runs)run.statistics=Object.fromEntries(Object.entries(run.statisticSums).map(([key,value])=>[key,f(value/run.frames)]));
  return {time,offsets:Int32Array.from(offsets),labels:Int32Array.from(labels),scores:Float32Array.from(scores),bestIds,frameStats,distributions,runs,text:runs.map(r=>r.char).join('').normalize('NFC')};
}

export function characterStatistics(lattice,encoding,frame,id) {
  const groups=lattice.distributions[frame];
  const probability=key=>groups.has(key)?f(Math.exp(groups.get(key).score)):0;
  let competitor=-Infinity;for(const group of groups.values())if(group.id!==id)competitor=Math.max(competitor,group.score);
  return {posterior:probability(id),blank:probability(encoding.blank),space:probability(encoding.space),competitor:competitor===-Infinity?0:f(Math.exp(competitor))};
}

export function latticeAlternatives(lattice,encoding,start=0,end=lattice.time-1,{limit=20}={}) {
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>=lattice.time||end<start)throw new RangeError('Invalid word lattice frame span');
  let paths=[{score:0,previous:null,id:null}];
  for(let t=start;t<=end;t++) {
    const begin=lattice.offsets[t],finish=lattice.offsets[t+1];if(begin===finish)continue;
    const next=[];
    for(let i=begin;i<finish;i++)for(const path of paths)next.push({id:lattice.labels[i],score:f(path.score+lattice.scores[i]),previous:path});
    next.sort((a,b)=>b.score-a.score);paths=next.slice(0,limit);
  }
  const merged=new Map();
  for(const path of paths) {
    const ids=[];for(let current=path;current.id!==null;current=current.previous)ids.push(current.id);ids.reverse();
    let previous=-1,text='';
    for(const id of ids){if(id!==encoding.blank&&id!==previous)text+=encoding.rawAlphabet[id];previous=id;}
    text=text.replace(/^ +| +$/g,'');if(!text)continue;
    merged.set(text,logAdd(merged.get(text)??-Infinity,path.score));
  }
  return [...merged].map(([text,score])=>({text,score})).sort((a,b)=>b.score-a.score);
}

export function wordFeatureInput(group,lattice,encoding,start,end) {
  return {text:group.map(r=>r.physicalChar).join(''),characters:group.map(run=>{
    const metadata={id:run.id,physicalId:run.id,type:run.id===encoding.blank?4:run.id===encoding.space?5:0,text:run.physicalChar};
    return {...run.statistics,firstFrame:run.start,lastFrame:run.end-1,character:metadata,rawCharacter:metadata};
  }),alternatives:latticeAlternatives(lattice,encoding,start,end)};
}
