export const PDF_MAX_SELECTED_PAGES=20;
export const PDF_MAX_PAGE_PIXELS=12_000_000;
export const PDF_MAX_TOTAL_PIXELS=80_000_000;
export const PDF_MAX_DIMENSION=10_000;
export const PDF_DEFAULT_DPI=150;
export const PDF_MIN_DPI=72;
export const PDF_MAX_DPI=300;
const PDF_MAX_PAGE_NUMBER=1_000_000;

export class PdfInputError extends Error {
  constructor(code,message,status=422){super(message);this.name='PdfInputError';this.code=code;this.status=status;}
}

export function parsePdfPages(value) {
  if(value===undefined||value===null)return null;
  if(typeof value!=='string'||value.length===0||value.length>256)throw new PdfInputError('pdf_page_selection','pdf_pages must be a comma-separated 1-based page selection');
  const parts=value.split(',');
  if(parts.length>PDF_MAX_SELECTED_PAGES)throw new PdfInputError('pdf_page_limit',`Select at most ${PDF_MAX_SELECTED_PAGES} PDF pages`);
  const ranges=[];let count=0;
  for(const part of parts) {
    const match=/^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(part);
    if(!match)throw new PdfInputError('pdf_page_selection','pdf_pages must contain positive page numbers or ascending ranges such as 1,3-5');
    const start=Number(match[1]),end=Number(match[2]??match[1]);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>PDF_MAX_PAGE_NUMBER||end>PDF_MAX_PAGE_NUMBER||end<start)throw new PdfInputError('pdf_page_selection','PDF page numbers must be ascending safe integers no greater than 1000000');
    count+=end-start+1;
    if(count>PDF_MAX_SELECTED_PAGES)throw new PdfInputError('pdf_page_limit',`Select at most ${PDF_MAX_SELECTED_PAGES} PDF pages`);
    ranges.push([start,end]);
  }
  ranges.sort((a,b)=>a[0]-b[0]);
  for(let i=1;i<ranges.length;i++)if(ranges[i][0]<=ranges[i-1][1])throw new PdfInputError('pdf_page_selection','pdf_pages must not contain duplicate or overlapping pages');
  return ranges.flatMap(([start,end])=>Array.from({length:end-start+1},(_,index)=>start+index));
}

export function selectPdfPages(requested,pageCount) {
  if(!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>PDF_MAX_PAGE_NUMBER)throw new PdfInputError('invalid_pdf','PDF page count is invalid or exceeds the supported limit',400);
  if(requested===null) {
    if(pageCount>PDF_MAX_SELECTED_PAGES)throw new PdfInputError('pdf_page_limit',`PDF has ${pageCount} pages; select at most ${PDF_MAX_SELECTED_PAGES} with pdf_pages`);
    return Array.from({length:pageCount},(_,index)=>index+1);
  }
  if(requested.some(page=>page>pageCount))throw new PdfInputError('pdf_page_selection',`pdf_pages contains a page beyond the document's ${pageCount} pages`);
  return requested;
}

export function validatePdfPageDimensions(width,height) {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<2||height<2||width>PDF_MAX_DIMENSION||height>PDF_MAX_DIMENSION)throw new PdfInputError('pdf_page_pixel_limit',`Rendered PDF page dimensions must be between 2 and ${PDF_MAX_DIMENSION} pixels`,422);
  const pixels=Math.ceil(width)*Math.ceil(height);
  if(!Number.isSafeInteger(pixels)||pixels>PDF_MAX_PAGE_PIXELS)throw new PdfInputError('pdf_page_pixel_limit',`Rendered PDF page exceeds the ${PDF_MAX_PAGE_PIXELS} pixel per-page limit`,422);
  return {width:Math.ceil(width),height:Math.ceil(height),pixels};
}
