// Capability and document hooks: events, downloads, lifts and the page's own functions.
// Evaluated in the same sandbox realm as code-api.ts.
export const browserCapabilityApi = `
function __event(target, event, options = {}) {
  var started = __call({op:'event',target,action:'subscribe',event,...(options.frameId ? {frameId:options.frameId,frameKey:options.frameKey} : {})});
  var id, ready = started.then(result=>{id=result.data.subscriptionId;return id;});
  var cancelled = false, consumed;
  async function dispose() {cancelled=true;await ready;return __call({op:'event',target,action:'dispose',subscriptionId:id});}
  async function consume() {
    await ready;
    var deadline=Date.now()+(options.timeoutMs ?? 10000);
    try {
      while(!cancelled && Date.now()<deadline) {
        var result=await __call({op:'event',target,action:'poll',subscriptionId:id,timeoutMs:Math.min(1000,deadline-Date.now())});
        if(result.data.dropped)console.warn('Event buffer dropped '+result.data.dropped+' entries; narrow the event and verify the outcome');
        for(var item of result.data.events) if(!options.predicate || options.predicate(item.params)) return item;
      }
      throw Error(cancelled ? 'Event subscription disposed' : 'TIMEOUT: browser event not observed');
    } finally {await dispose().catch(()=>{});}
  }
  return Object.freeze({ready,dispose,then:(resolve,reject)=>(consumed??=consume()).then(resolve,reject)});
}
function __framePage(target, info) {
  var scoped={frameId:info.frameId,frameKey:info.frameKey};
  var call=async(action,fields={})=>(await __step({op:'frames',target,action,...scoped,...fields})).data;
  return Object.freeze({...info,
    evaluate:(fn,arg)=>call('evaluate',{expression:__expression(fn,arg)}),
    cdp:(method,params={})=>call('cdp',{method,params}),
    snapshot:()=>call('snapshot'),
    click:element=>call('click',typeof element==='number'?{backendNodeId:element}:{selector:element}),
    fill:(element,value)=>call('fill',{...(typeof element==='number'?{backendNodeId:element}:{selector:element}),value}),
    locator:selector=>Object.freeze({click:()=>call('click',{selector}),fill:value=>call('fill',{selector,value})}),
    getByRole:(role,options={})=>Object.freeze({click:async()=>{var state=await call('snapshot');var nodes=state.nodes.filter(n=>n.role===role && (options.name===undefined || n.name===options.name));if(nodes.length!==1)throw Error('Expected exactly one frame control');return call('click',{backendNodeId:nodes[0].backendNodeId});},fill:async value=>{var state=await call('snapshot');var nodes=state.nodes.filter(n=>n.role===role && (options.name===undefined || n.name===options.name));if(nodes.length!==1)throw Error('Expected exactly one frame control');return call('fill',{backendNodeId:nodes[0].backendNodeId,value});}}),
    upload:(selector,files)=>__step({op:'upload',target,selector,files,...scoped}),
    press:(keys)=>__step({op:'keys',target,keys,...scoped}),
    waitForEvent:(event,options={})=>__event(target,event,{...options,...scoped}),
  });
}
function __expression(fn,arg) {return typeof fn==='function' ? '('+fn.toString()+')('+(JSON.stringify(arg) ?? '')+')' : fn;}
// Written in 1M-character pieces (whole base64 quads, whole surrogate pairs), so a large file
// never becomes one oversized message.
async function artifact(name,data) {
  if (typeof Blob!=='undefined' && data instanceof Blob) data=new Uint8Array(await data.arrayBuffer());
  // Anything that isn't bytes (objects, arrays of rows) is saved as JSON.
  else if (data && typeof data==='object' && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && !(Array.isArray(data) && data.every(n=>typeof n==='number'))) data=JSON.stringify(data,null,2);
  var base64=typeof data!=='string', value=base64?__encodeBytes(data):data, size=1000000, at=0, result;
  do {
    var end=Math.min(value.length,at+size);
    var last=value.charCodeAt(end-1);
    if(!base64 && end<value.length && last>=0xD800 && last<=0xDBFF) end--;
    result=await __call({workspace:at?'append':'artifact',name,value:value.slice(at,end),base64});
    at=end;
  } while(at<value.length);
  return {...result,bytes:base64?Math.floor(value.length*3/4)-(value.endsWith('==')?2:value.endsWith('=')?1:0):new TextEncoder().encode(value).length};
}
var checkpoint=(name,value)=>__call({workspace:'checkpoint',name,value});
var loadCheckpoint=name=>__call({workspace:'load',name});
var saveHelper=(name,fn)=>__call({workspace:'helper',name,value:typeof fn==='function'?'('+fn.toString()+')':fn});
var loadHelper=async name=>eval(await __call({workspace:'loadHelper',name}));
var showImage=async name=>{await __call({workspace:'image',name});return {displayed:true,path:name};};
var __hasDelivered=false,__deliveryValue;
var finish_from_js=({expression})=>{__deliveryValue=eval(expression);__hasDelivered=true;return {delivered:true};};
var reconnect=()=>browser.page(__lastTarget).reconnect();
`;
export const browserDocumentApi = `
function __pageFunctions() {
  var out = [];
  for (var key of Object.getOwnPropertyNames(window)) {
    try {
      var value = window[key];
      if (typeof value === 'function' && key !== 'window' && key.indexOf('__') !== 0)
        out.push({name: key, arity: value.length});
    } catch (error) {}
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}
async function __readPdfText(options = {}) {
  var root=window;
  if(options.selector) {
    var selected=document.querySelector(options.selector);
    if(!selected)throw Error('PDF_TEXT_UNAVAILABLE: viewer selector was not found');
    root=selected.contentWindow || window;
  }
  var queue=[root],seen=new Set(),documents=[],layers=[];
  while(queue.length && seen.size<64) {
    var w=queue.shift(); if(seen.has(w))continue; seen.add(w);
    try {
      var d=w.document;
      var pdf=w.PDFViewerApplication?.pdfDocument;
      if(!pdf && w.PDFVar?._transport?.loadingTask?.promise) pdf=await w.PDFVar._transport.loadingTask.promise;
      if(pdf && typeof pdf.getPage==='function')documents.push({pdf,url:w.location.href});
      else {
        var rendered=[...d.querySelectorAll('.textLayer')].map(e=>e.innerText || e.textContent || '').filter(Boolean);
        if(rendered.length)layers.push({url:w.location.href,pages:rendered});
      }
      for(var f of d.querySelectorAll('iframe,frame'))if(f.contentWindow)queue.push(f.contentWindow);
    } catch(error) { if(!/SecurityError|cross-origin|Blocked a frame/i.test(String(error)))throw error; }
  }
  if(documents.length>1)throw Error('AMBIGUOUS_PDF: choose a viewer iframe with {selector}');
  if(!documents.length) {
    if(layers.length===1)return {source:'rendered-text',url:layers[0].url,pages:layers[0].pages.map((text,i)=>({page:i+1,text})),partial:true,warning:'Only rendered text layers were available; page numbers may not match the document. Use screenshots for missing pages.'};
    throw Error('PDF_TEXT_UNAVAILABLE: no readable PDF.js document found. Use frame handles for cross-origin content or screenshots for image-only PDFs.');
  }
  var viewer=documents[0],total=viewer.pdf.numPages;
  var from=Math.max(1,options.from || 1),to=Math.min(total,options.to || total,from+99);
  var budget=Math.min(800000,Math.max(1000,options.maxChars || 200000)),pages=[],clipped=false;
  for(var i=from;i<=to;i++) {
    var content=await (await viewer.pdf.getPage(i)).getTextContent();
    var text=content.items.map(item=>item.str+(item.hasEOL?'\\n':' ')).join('').trim();
    var take=text.slice(0,budget);pages.push({page:i,text:take,truncated:take.length!==text.length});budget-=take.length;
    if(take.length!==text.length || budget<=0){clipped=i<total || take.length!==text.length;break;}
  }
  return {source:'pdfjs',url:viewer.url,totalPages:total,pages,partial:clipped || from!==1 || to!==total,
    ...(pages.every(p=>!p.text)?{warning:'No text extracted; this may be an image-only PDF. Use screenshots.'}:{})};
}
`;
