import {createCanvas} from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {selectPdfPages,validatePdfPageDimensions,PDF_MAX_TOTAL_PIXELS,PDF_DEFAULT_DPI,PDF_MIN_DPI,PDF_MAX_DPI} from './pdf-options.mjs';
import {capturePdfWarningOutput} from './pdf-warning-capture.mjs';

const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../node_modules/pdfjs-dist');
const localAsset=path=>`${resolve(packageRoot,path).split(sep).join('/')}/`;
let documentProxy=null,loadingTask=null,selectedPages=[],dpi=PDF_DEFAULT_DPI,pageMetadata=new Map(),busy=false;
const send=(message,callback)=>{if(process.connected)process.send(message,callback);};

process.on('message',message=>{
  if(busy)return;
  busy=true;
  (async()=>{
    if(message?.type==='open')await openDocument(message);
    else if(message?.type==='render')await renderPage(message.pageNumber);
    else if(message?.type==='close'){await closeDocument();send({type:'closed'},()=>process.exit(0));}
    else throw new Error('invalid_worker_message');
  })().catch(error=>send({type:'error',code:classify(error)})).finally(()=>{busy=false;});
});

async function openDocument(message) {
  dpi=message.dpi;
  if(!Number.isSafeInteger(dpi)||dpi<PDF_MIN_DPI||dpi>PDF_MAX_DPI)throw new Error('invalid_pdf_dpi');
  const data=message.data;
  if(!(data instanceof Uint8Array)||data.length<5)throw new Error('invalid_pdf');
  // Pinned pdfjs-dist 6.4.299 can omit an over-cap image without rejecting a
  // render when stopAtErrors is true. Keep the image cap and fail on warnings
  // below so the API never returns a successful partial page.
  const loading=pdfjs.getDocument({
    data,
    cMapUrl:localAsset('cmaps'),cMapPacked:true,
    standardFontDataUrl:localAsset('standard_fonts'),
    wasmUrl:localAsset('wasm'),
    useWorkerFetch:false,useSystemFonts:false,enableXfa:false,stopAtErrors:false,
    maxImageSize:12_000_000,
    verbosity:pdfjs.VerbosityLevel.WARNINGS,
  });
  loadingTask=loading;
  const warnings=[],restoreWarnings=capturePdfWarningOutput(warnings);
  try {
    try{documentProxy=await loading.promise;}catch(error){await loading.destroy().catch(()=>{});loadingTask=null;throw error;}
    const metadata=await documentProxy.getMetadata();
    if(metadata.info?.IsXFAPresent)throw new Error('pdf_xfa_unsupported');
    const pages=selectPdfPages(message.pages??null,documentProxy.numPages);
    selectedPages=pages;
    let totalPixels=0;
    for(const pageNumber of pages) {
      const page=await documentProxy.getPage(pageNumber);
      const viewport=page.getViewport({scale:dpi/72});
      const dimensions=validatePdfPageDimensions(viewport.width,viewport.height);
      totalPixels+=dimensions.pixels;
      pageMetadata.set(pageNumber,{pageNumber,width:dimensions.width,height:dimensions.height,pixels:dimensions.pixels,
        sourceView:[...page.view],userUnit:page.userUnit,rotation:page.rotate,transform:[...viewport.transform]});
      page.cleanup();
      if(totalPixels>PDF_MAX_TOTAL_PIXELS)throw new Error('pdf_total_pixel_limit');
    }
    if(warnings.length)throw new Error(`pdf_render_warning:${warnings.join(' | ')}`);
    send({type:'opened',pageCount:documentProxy.numPages,pages:pages.map(number=>pageMetadata.get(number)),totalPixels});
  } finally {restoreWarnings();}
}

async function renderPage(pageNumber) {
  const metadata=pageMetadata.get(pageNumber);
  if(!documentProxy||!metadata||!selectedPages.includes(pageNumber))throw new Error('invalid_pdf_page_selection');
  const page=await documentProxy.getPage(pageNumber);
  const viewport=page.getViewport({scale:dpi/72});
  const dimensions=validatePdfPageDimensions(viewport.width,viewport.height);
  if(dimensions.width!==metadata.width||dimensions.height!==metadata.height)throw new Error('pdf_page_geometry_changed');
  const canvas=createCanvas(metadata.width,metadata.height),context=canvas.getContext('2d');
  const warnings=[],restoreWarnings=capturePdfWarningOutput(warnings);
  let renderTask;
  try {
    context.fillStyle='#fff';context.fillRect(0,0,metadata.width,metadata.height);
    renderTask=page.render({canvasContext:context,viewport,canvas,annotationMode:pdfjs.AnnotationMode.ENABLE});
    await renderTask.promise;
    if(warnings.length)throw new Error(`pdf_render_warning:${warnings.join(' | ')}`);
    const png=canvas.toBuffer('image/png');
    send({type:'page',pageNumber,width:metadata.width,height:metadata.height,png:new Uint8Array(png.buffer,png.byteOffset,png.byteLength)});
  } catch(error) {
    renderTask?.cancel();throw error;
  } finally {
    restoreWarnings();
    canvas.width=0;canvas.height=0;
    page.cleanup();
  }
}

async function closeDocument() {
  documentProxy=null;pageMetadata.clear();selectedPages=[];
  const task=loadingTask;loadingTask=null;
  if(task)await task.destroy();
}

function classify(error) {
  const name=String(error?.name??''),code=String(error?.code??error?.message??'');
  if(name==='PasswordException')return 'pdf_password_required';
  if(code==='pdf_page_limit')return 'pdf_page_limit';
  if(code==='pdf_page_selection'||code==='invalid_pdf_page_selection')return 'pdf_page_selection';
  if(code==='pdf_page_pixel_limit'||code==='pdf_total_pixel_limit')return code;
  if(code==='pdf_xfa_unsupported')return code;
  if(code==='invalid_pdf_dpi')return code;
  if(code.startsWith('pdf_render_warning')||code==='pdf_page_geometry_changed')return 'pdf_render_failed';
  if(name==='InvalidPDFException'||name==='MissingPDFException'||name==='FormatError'||name==='UnknownErrorException'||code==='invalid_pdf')return 'invalid_pdf';
  return 'pdf_render_failed';
}
