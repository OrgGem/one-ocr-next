// Label-based scoring shared by the Linux runner and metric unit tests.
// No model output participates in defining labels or acceptance thresholds.
export const normalize = text => String(text ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();

export function distance(a,b) {
  let previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=0;i<a.length;i++) {
    const current=[i+1];
    for(let j=0;j<b.length;j++)current.push(Math.min(current[j]+1,previous[j+1]+1,previous[j]+(a[i]===b[j]?0:1)));
    previous=current;
  }
  return previous[b.length];
}

export function contains(polygon,[x,y]) {
  // Convex authored cells, including rotated quadrilaterals; edges inclusive.
  let sign=0;
  for(let i=0;i<polygon.length;i++) {
    const a=polygon[i],b=polygon[(i+1)%polygon.length];
    const cross=(b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]);
    if(Math.abs(cross)<1e-6)continue;
    if(sign&&Math.sign(cross)!==sign)return false;
    sign=Math.sign(cross);
  }
  return true;
}

export function quad(rect) {
  return Array.from({length:4},(_,i)=>[rect?.[`x${i+1}`],rect?.[`y${i+1}`]]);
}

export function evaluate(sample,result) {
  const buckets=new Map(sample.cells.map(c=>[c.id,[]]));
  const invalidGeometry=[],unassigned=[],observedOrder=[];
  let words=0,validWords=0;
  for(const [lineIndex,line] of (result.lines??[]).entries())for(const [wordIndex,word] of (line.words??[]).entries()) {
    words++;
    const points=quad(word.bounding_rect);
    const area=Math.abs(points.reduce((sum,p,i)=>{const q=points[(i+1)%4];return sum+p[0]*q[1]-q[0]*p[1];},0))/2;
    const valid=points.every(p=>p.every(Number.isFinite)&&p[0]>=-2&&p[0]<=sample.width+2&&p[1]>=-2&&p[1]<=sample.height+2)&&area>0;
    if(!valid){invalidGeometry.push({lineIndex,wordIndex,text:word.text,points});continue;}
    validWords++;
    const center=[points.reduce((s,p)=>s+p[0],0)/4,points.reduce((s,p)=>s+p[1],0)/4];
    const hits=sample.cells.filter(c=>contains(c.polygon,center));
    if(hits.length!==1){unassigned.push({text:word.text,center,matches:hits.map(c=>c.id)});continue;}
    const cell=hits[0];
    buckets.get(cell.id).push({text:word.text,center,lineIndex,wordIndex});
    if(observedOrder.at(-1)!==cell.id)observedOrder.push(cell.id);
  }
  const cells=sample.cells.map(cell=>{
    // Within a cell, use detected line order, then word order. Do not sort by
    // labels or silently move words to repair the engine's reading order.
    const actual=normalize(buckets.get(cell.id).map(w=>w.text).join(' '));
    const expected=normalize(cell.text),edits=distance([...expected],[...actual]);
    return {id:cell.id,row:cell.row,column:cell.column,numeric:!!cell.numeric,expected,actual,
      exact:expected===actual,characterEdits:edits,characters:[...expected].length,
      wordEdits:distance(expected.split(' '),actual?actual.split(' '):[]),words:expected.split(' ').length};
  });
  const expectedOrder=sample.cells.map(c=>c.id);
  const readingOrderExact=JSON.stringify(observedOrder)===JSON.stringify(expectedOrder);
  const cellCharacterEdits=cells.reduce((s,c)=>s+c.characterEdits,0);
  const cellCharacters=cells.reduce((s,c)=>s+c.characters,0);
  const expected=normalize(sample.expectedText),actual=normalize(result.text);
  const numericCells=cells.filter(c=>c.numeric);
  const exactCells=cells.filter(c=>c.exact).length;
  const geometryValid=words>0&&invalidGeometry.length===0;
  return {passed:actual===expected&&exactCells===cells.length&&geometryValid&&!unassigned.length&&readingOrderExact,
    exactText:actual===expected,characterErrorRate:distance([...expected],[...actual])/Math.max(1,[...expected].length),
    wordErrorRate:distance(expected.split(' '),actual?actual.split(' '):[])/Math.max(1,expected.split(' ').length),
    cellCharacterErrorRate:cellCharacterEdits/Math.max(1,cellCharacters),cellCharacterEdits,cellCharacters,
    exactCells,totalCells:cells.length,exactNumericCells:numericCells.filter(c=>c.exact).length,numericCells:numericCells.length,
    geometryValid,words,validWords,invalidGeometry,unassigned,readingOrderExact,expectedOrder,observedOrder,cells};
}
