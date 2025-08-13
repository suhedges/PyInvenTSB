// ---- Small helpers ----------------------------------------------------------
function qs(s, el=document){return el.querySelector(s)}
function qsa(s, el=document){return [...el.querySelectorAll(s)]}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function apiGet(url){return axios.get(url)}
function apiPost(url, data){return axios.post(url, data)}
function apiPut(url, data){return axios.put(url, data)}
function apiDel(url){return axios.delete(url)}

function isSecure(){
  if (window.isSecureContext) return true;
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1";
}
function inIframe(){
  try { return window.self !== window.top; } catch(_) { return true; }
}
function msgElFor(targetSel){
  if (targetSel==="#scanner") return qs("#camMsg");
  if (targetSel==="#inline-view") return qs("#inlineMsg");
  if (targetSel==="#massView") return qs("#massMsg");
  return null;
}
function showCamMsg(targetSel, text, level="warn"){
  const el = msgElFor(targetSel); if (!el) return;
  el.textContent = text;
  el.className = "hint " + (level==="error" ? "error" : "muted");
  el.style.display = text ? "" : "none";
}

// ===== Scanner core (ZXing frame-grab + focus controls + fallbacks) ==========
let _scannerRunning = false;
let _currentTargetSel = null;
let _torchOn = false;
let _engineInUse = null;
let _lastHitAt = 0;
let _watchdogTimer = null;
let _liveLoopTimer = null;
let _imageCapture = null;
let _currentTrack = null;
// NEW: when true, #scanModal acts as “assign to open product” overlay
let _assignOverlay = false;

const WATCHDOG_MS = 6000; // escalate engine if no detection in this window
const CONSENSUS_NEED = 2;
const CONSENSUS_MAX  = 6;
const LIVE_FPS_MS    = 120; // ~8 fps frame grabs

function buildFormats(sym){
  if (sym === "code128") return ["code_128","ean_13","upc_a","upc_e","ean_8"];
  if (sym === "upcean")  return ["upc_a","upc_e","ean_13","ean_8"];
  return ["code_128","upc_a","upc_e","ean_13","ean_8"];
}
function buildZXHints(sym){
  const Z = window.ZXing;
  if (!(Z && Z.DecodeHintType)) return null;
  const map = {
    code_128: Z.BarcodeFormat.CODE_128,
    ean_13:   Z.BarcodeFormat.EAN_13,
    ean_8:    Z.BarcodeFormat.EAN_8,
    upc_a:    Z.BarcodeFormat.UPC_A,
    upc_e:    Z.BarcodeFormat.UPC_E
  };
  const fmts = buildFormats(sym).map(f=>map[f]).filter(Boolean);
  const hints = new Map();
  if (fmts.length) hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, fmts);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  if (Z.DecodeHintType.ASSUME_GS1) hints.set(Z.DecodeHintType.ASSUME_GS1, false);
  return hints;
}
function supportsNative(){
  try{
    if (typeof window.BarcodeDetector !== 'function') return false;
    const det = new window.BarcodeDetector({formats:['code_128']});
    return !!det && typeof det.detect === 'function';
  }catch(_){ return false; }
}
function avgErr(res){
  const arr = (res && res.codeResult && res.codeResult.decodedCodes) || [];
  const errs = arr.map(c => c.error).filter(e => typeof e === "number");
  if (!errs.length) return 1;
  const s = errs.reduce((a,b)=>a+b,0);
  return s/errs.length;
}
function hardStop(targetSel){
  try{ Quagga.offDetected(); Quagga.offProcessed(); Quagga.stop(); }catch(_){}
  if (_watchdogTimer){ clearTimeout(_watchdogTimer); _watchdogTimer = null; }
  if (_liveLoopTimer){ clearTimeout(_liveLoopTimer); _liveLoopTimer = null; }
  _engineInUse = null;
  _imageCapture = null;
  _currentTrack = null;

  if (targetSel){
    const t = document.querySelector(targetSel);
    if (t) t.innerHTML = "";
  }
  qsa("video").forEach(v=>{
    try{ if (v.srcObject) v.srcObject.getTracks().forEach(tr=>tr.stop()); }catch(_){}
    try{ v.srcObject = null; }catch(_){}
  });
  _scannerRunning = false;
  _currentTargetSel = null;
  _torchOn = false;
  _assignOverlay = false; // reset mode when scanner stops
}
function ensureVideo(targetSel){
  const t = qs(targetSel);
  let v = qs("video", t);
  if (!v){
    v = document.createElement("video");
    v.setAttribute("playsinline", "true");
    v.setAttribute("autoplay", "true");
    v.muted = true;
    v.style.width = "100%";
    v.style.height = "100%";
    t.appendChild(v);
  }
  return v;
}
async function enumerateCameras(){
  try{
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d=>d.kind === 'videoinput');
  }catch(_){ return []; }
}
function pickRearCamera(devs){
  if (!devs || !devs.length) return null;
  return devs.find(d=>/back|rear|environment/i.test(d.label)) || devs[devs.length-1];
}
function getTrackFor(targetSel){
  try{
    const v = qs(`${targetSel} video`);
    if (v && v.srcObject) return v.srcObject.getVideoTracks()[0] || null;
  }catch(_){}
  return null;
}
async function setTorch(on){
  const track = getTrackFor(_currentTargetSel || "#scanner");
  if (!track) return false;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if (!caps.torch) return false;
  try{
    await track.applyConstraints({ advanced:[{ torch: !!on }] });
    _torchOn = !!on;
    return true;
  }catch(_){ return false; }
}
async function toggleTorch(e){
  if (e) e.preventDefault();
  const ok = await setTorch(!_torchOn);
  if (!ok) alert("Flash not supported on this device/browser.");
}
async function applyZoomUI(targetSel){
  const rangeId = (targetSel==="#scanner")? "#zoomRange" : (targetSel==="#inline-view")? "#inlineZoom" : "#massZoom";
  const range = qs(rangeId);
  if (!range) return;
  const track = getTrackFor(targetSel);
  if (!track || !track.getCapabilities) { range.disabled = true; return; }
  const caps = track.getCapabilities();
  if (!caps.zoom){ range.disabled = true; return; }
  const settings = track.getSettings ? track.getSettings() : {};
  const min = caps.zoom.min || 1, max = caps.zoom.max || 1;
  range.min = Math.max(1, min);
  range.max = Math.max(range.min, max);
  range.step = ((caps.zoom.step||0.1) || 0.1);
  range.value = settings.zoom || range.min;
  range.disabled = false;
  range.oninput = async (e)=>{
    try{ await track.applyConstraints({ advanced: [{ zoom: parseFloat(e.target.value) }] }); }catch(_){}
  };
}
async function applyFocusExposureUI(targetSel){
  const track = getTrackFor(targetSel);
  if (!track || !track.getCapabilities) return;
  const caps = track.getCapabilities();
  const settings = track.getSettings ? track.getSettings() : {};

  // Focus slider
  const fId = (targetSel==="#scanner")? "#focusRange" : (targetSel==="#inline-view")? "#inlineFocus" : "#massFocus";
  const f = qs(fId);
  if (f && caps.focusDistance){
    f.min = caps.focusDistance.min ?? 0;
    f.max = caps.focusDistance.max ?? 1;
    f.step = caps.focusDistance.step ?? 0.01;
    f.value = settings.focusDistance ?? f.min;
    f.disabled = false;
    f.oninput = async (e)=>{
      try{
        await track.applyConstraints({ advanced: [{ focusMode: "manual", focusDistance: parseFloat(e.target.value) }] });
      }catch(_){}
    };
  } else if (f){
    f.disabled = true;
  }

  // Exposure slider
  const eId = (targetSel==="#scanner")? "#exposureRange" : (targetSel==="#inline-view")? "#inlineExposure" : "#massExposure";
  const ex = qs(eId);
  if (ex && caps.exposureCompensation){
    ex.min = caps.exposureCompensation.min ?? -2;
    ex.max = caps.exposureCompensation.max ?? 2;
    ex.step = caps.exposureCompensation.step ?? 0.1;
    ex.value = settings.exposureCompensation ?? 0;
    ex.disabled = false;
    ex.oninput = async (ev)=>{
      try{
        await track.applyConstraints({ advanced: [{ exposureMode: "continuous", exposureCompensation: parseFloat(ev.target.value) }] });
      }catch(_){}
    };
  } else if (ex){
    ex.disabled = true;
  }
}
async function doAutofocus(e, targetSel){
  if (e) { e.preventDefault?.(); e.stopPropagation?.(); }
  const track = getTrackFor(targetSel);
  if (!track) return;
  try{
    const cap = new ImageCapture(track);
    await cap.setOptions({ focusMode: "single-shot" });
    try { await cap.takePhoto().catch(()=>{}); } catch(_){}
  }catch(_){
    try{ await track.applyConstraints({ advanced:[{ focusMode: "continuous" }] }); }catch(__){}
  }
}
function hookTapToFocus(targetSel){
  const host = qs(targetSel);
  if (!host) return;
  host.onclick = async (ev)=>{
    const track = getTrackFor(targetSel);
    if (!track) return;
    let cap=null;
    try{ cap = new ImageCapture(track); }catch(_){}
    if (!cap || !cap.setOptions){ doAutofocus(ev, targetSel); return; }
    const rect = host.getBoundingClientRect();
    const x = (ev.clientX - rect.left) / rect.width;
    const y = (ev.clientY - rect.top) / rect.height;
    try{
      await cap.setOptions({ pointsOfInterest: [{ x, y }], focusMode: "single-shot" });
      try { await cap.takePhoto().catch(()=>{}); } catch(_){}
    }catch(_){
      doAutofocus(ev, targetSel);
    }
  };
}

// Watchdog escalates engine if no detections
function armWatchdog(targetSel, sym, onAccept, engOrder){
  if (_watchdogTimer) clearTimeout(_watchdogTimer);
  _watchdogTimer = setTimeout(async ()=>{
    if (!_scannerRunning) return;
    if (Date.now() - _lastHitAt < WATCHDOG_MS - 500) { armWatchdog(targetSel, sym, onAccept, engOrder); return; }
    const idx = engOrder.indexOf(_engineInUse);
    const next = engOrder[idx+1];
    if (next){
      const openSel = _currentTargetSel;
      const accept = onAccept;
      hardStop(openSel);
      _currentTargetSel = openSel;
      _scannerRunning = true;
      await startWithEngine(next, openSel, sym, accept, engOrder);
    } else {
      armWatchdog(targetSel, sym, onAccept, engOrder);
    }
  }, WATCHDOG_MS);
}

// ---- Video start with progressive constraints + diagnostics ------------------
async function startVideo(targetSel, desiredDeviceId){
  const v = ensureVideo(targetSel);

  // Pre-flight diagnostics
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    showCamMsg(targetSel, "Camera API not available in this browser.", "error");
    throw new Error("getUserMedia missing");
  }
  if (!isSecure()){
    showCamMsg(targetSel, "Camera blocked: site must be HTTPS or localhost. If on Replit, click 'Open in new tab'.", "error");
  }
  if (inIframe()){
    showCamMsg(targetSel, "If the preview is inside an iframe, your browser may block the camera. Open in a new tab/window.", "warn");
  }

  const attempts = [
    { video: {
        deviceId: desiredDeviceId ? { exact: desiredDeviceId } : undefined,
        facingMode: desiredDeviceId ? undefined : { ideal: "environment" },
        width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 },
        advanced: [{ focusMode: "continuous" }]
      }, audio: false
    },
    { video: { facingMode: { ideal: "environment" } }, audio: false },
    { video: true, audio: false }
  ];

  let lastErr = null;
  for (let i=0;i<attempts.length;i++){
    try{
      const c = attempts[i];
      const stream = await navigator.mediaDevices.getUserMedia(c);
      v.srcObject = stream;

      // Make sure autoplay isn't blocked
      try{ await v.play(); }catch(_){ /* some browsers don't resolve; that's ok */ }

      // Wait for metadata; if dimensions stay 0, try next constraints
      for (let t=0; t<15; t++){ // ~1.5s total
        if (v.videoWidth && v.videoHeight) break;
        await sleep(100);
      }
      if (!v.videoWidth || !v.videoHeight){
        // Try nudging play again (some WebKit builds)
        try{ await v.play(); }catch(_){}
        await sleep(200);
      }

      if (v.videoWidth && v.videoHeight){
        _currentTrack = getTrackFor(targetSel);
        try{ _imageCapture = new ImageCapture(_currentTrack); }catch(_){ _imageCapture = null; }
        await applyZoomUI(targetSel);
        await applyFocusExposureUI(targetSel);
        hookTapToFocus(targetSel);
        showCamMsg(targetSel, ""); // clear any warnings
        return v;
      }

      // stop and fall through to next attempt
      try{ stream.getTracks().forEach(t=>t.stop()); }catch(_){}
      lastErr = new Error("No video dimensions after play");
    }catch(e){
      lastErr = e;
    }
  }

  showCamMsg(targetSel, "Could not start the camera. Check permissions and try opening in a new tab.", "error");
  throw lastErr || new Error("Camera start failed");
}

// ---- ZXing frame-grab loop (primary engine) ---------------------------------
async function startZXingLive(targetSel, sym, onAccept, engOrder){
  _engineInUse = "zxing";
  const Z = window.ZXing;
  if (!(Z && Z.BrowserMultiFormatReader)) throw new Error("ZXing unavailable");
  const hints = buildZXHints(sym);
  const reader = new Z.BrowserMultiFormatReader(hints);

  // Use selected camera if chosen
  const camSel = (targetSel==="#scanner")? "#camera" : (targetSel==="#inline-view")? "#inlineCamera" : "#massCamera";
  const deviceId = qs(camSel)?.value || undefined;

  const v = await startVideo(targetSel, deviceId);

  // If user changes camera, restart stream with new device
  const camPicker = qs(camSel);
  if (camPicker){
    camPicker.onchange = async ()=>{
      const acceptCb = onAccept;
      const symb = sym;
      const order = engOrder;
      stopScanner(false);
      _currentTargetSel = targetSel;
      _scannerRunning = true;
      await startWithEngine("zxing", targetSel, symb, acceptCb, order);
    };
  }

  // Offscreen canvas for ROI decoding
  const off = document.createElement("canvas");
  const ctx = off.getContext("2d", { willReadFrequently: true });

  let consensus = [];
  function accept(code){
    consensus.push(code);
    if (consensus.length>CONSENSUS_MAX) consensus.shift();
    const counts = {}; consensus.forEach(c=>counts[c]=(counts[c]||0)+1);
    const best = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    if (best && best[1] >= CONSENSUS_NEED){
      _lastHitAt = Date.now();
      onAccept(best[0]);
      consensus = [];
    }
  }

  const loop = async ()=>{
    if (!_scannerRunning || _engineInUse!=="zxing") return;

    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh){ _liveLoopTimer = setTimeout(loop, LIVE_FPS_MS); return; }

    // Center ROI — tunable if needed
    const roiW = Math.round(vw * 0.72);
    const roiH = Math.round(vh * 0.40);
    const sx = Math.max(0, Math.floor((vw - roiW)/2));
    const sy = Math.max(0, Math.floor((vh - roiH)/2));

    off.width = roiW; off.height = roiH;
    ctx.drawImage(v, sx, sy, roiW, roiH, 0, 0, roiW, roiH);

    try{
      const res = await reader.decodeFromCanvas(off);
      if (res && res.getText){
        const txt = String(res.getText()).trim();
        if (sym === "upcean" && /[^\d]/.test(txt)) {
          // ignore alphanum when expecting UPC/EAN only
        } else {
          accept(txt);
        }
      }
    }catch(_){ /* no decode this frame */ }

    _liveLoopTimer = setTimeout(loop, LIVE_FPS_MS);
  };

  loop();
  armWatchdog(targetSel, sym, onAccept, engOrder);
}

// ---- Quagga (secondary) -----------------------------------------------------
function quaggaConfig(targetSel, sym="code128"){
  const readers = (sym==="code128") ? ["code_128_reader"]
               : (sym==="upcean")   ? ["upc_reader","upc_e_reader","ean_reader","ean_8_reader"]
               : ["code_128_reader","upc_reader","upc_e_reader","ean_reader","ean_8_reader"];
  return {
    inputStream: {
      name: "Live",
      type: "LiveStream",
      target: document.querySelector(targetSel),
      constraints: {
        facingMode: "environment",
        width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }
      },
      area: { top: "10%", right: "12%", left: "12%", bottom: "10%" }
    },
    locator: { patchSize: "large", halfSample: false },
    numOfWorkers: navigator.userAgent.includes("Safari") ? 0 : 2,
    frequency: 8,
    decoder: { readers },
    locate: true
  };
}
async function startQuagga(targetSel, sym, onAccept, engOrder){
  _engineInUse = "quagga";
  Quagga.init(quaggaConfig(targetSel, sym), async function(err){
    if (err){ console.log(err); showCamMsg(targetSel, "Quagga failed to start camera.", "error"); return; }
    Quagga.start(); _scannerRunning = true;
    setTimeout(async ()=>{
      _currentTrack = getTrackFor(targetSel);
      try{ _imageCapture = new ImageCapture(_currentTrack); }catch(_){ _imageCapture = null; }
      await applyZoomUI(targetSel);
      await applyFocusExposureUI(targetSel);
      hookTapToFocus(targetSel);
      showCamMsg(targetSel, "");
    }, 250);
  });

  let windowCodes = [];
  Quagga.onDetected((res)=>{
    if (!_scannerRunning || _engineInUse !== "quagga") return;
    const cr = res && res.codeResult;
    const code = (cr && cr.code) ? String(cr.code).trim() : "";
    const fmt  = cr && cr.format;
    if (!code) return;
    if (avgErr(res) > 0.30) return;
    if (sym === "code128" && fmt !== "code_128") return;
    if (sym === "upcean"  && !["upc","upc_e","ean","ean_8"].includes(String(fmt).replace("-","_"))) return;

    windowCodes.push(code);
    if (windowCodes.length > CONSENSUS_MAX) windowCodes.shift();
    const counts = {}; windowCodes.forEach(c=>counts[c]=(counts[c]||0)+1);
    const best = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    if (best && best[1] >= CONSENSUS_NEED){
      _lastHitAt = Date.now();
      setTimeout(()=>onAccept(best[0]), 0);
      windowCodes = [];
    }
  });
  armWatchdog(targetSel, sym, onAccept, engOrder);
}

// ---- Native (tertiary) ------------------------------------------------------
async function startNative(targetSel, sym, onAccept, engOrder){
  _engineInUse = "native";
  if (!supportsNative()) throw new Error("Native unsupported");

  const camSel = (targetSel==="#scanner")? "#camera" : (targetSel==="#inline-view")? "#inlineCamera" : "#massCamera";
  const deviceId = qs(camSel)?.value || undefined;

  const v = await startVideo(targetSel, deviceId);
  let buf = [];
  const det = new window.BarcodeDetector({ formats: buildFormats(sym) });
  const loop = async ()=>{
    if (!_scannerRunning || _engineInUse!=="native") return;
    try{
      const results = await det.detect(v);
      for (const r of results){
        const code = String(r.rawValue||"").trim();
        if (!code) continue;
        if (sym === "upcean" && /[^\d]/.test(code)) continue;
        buf.push(code); if (buf.length>CONSENSUS_MAX) buf.shift();
        const counts = {}; buf.forEach(c=>counts[c]=(counts[c]||0)+1);
        const best = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
        if (best && best[1] >= CONSENSUS_NEED){
          _lastHitAt = Date.now(); onAccept(best[0]); buf=[];
        }
      }
    }catch(_){}
    _liveLoopTimer = setTimeout(loop, LIVE_FPS_MS);
  };
  loop();
  armWatchdog(targetSel, sym, onAccept, engOrder);
}

// ---- Master start/stop ------------------------------------------------------
async function startWithEngine(engine, targetSel, sym, onAccept, engOrder){
  if (engine === "zxing")   return startZXingLive(targetSel, sym, onAccept, engOrder);
  if (engine === "quagga")  return startQuagga(targetSel, sym, onAccept, engOrder);
  if (engine === "native")  return startNative(targetSel, sym, onAccept, engOrder);
  return startZXingLive(targetSel, sym, onAccept, engOrder);
}
async function startScanner(targetSel, onAccept, sym="code128", engine="auto"){
  if (_scannerRunning) return;
  showCamMsg(targetSel, ""); // clear
  hardStop(targetSel);
  _currentTargetSel = targetSel;
  _scannerRunning = true;
  _lastHitAt = Date.now();

  // Populate camera pickers
  try{
    const cams = await enumerateCameras();
    const selId = (targetSel==="#scanner")? "#camera" : (targetSel==="#inline-view")? "#inlineCamera" : "#massCamera";
    const sel = qs(selId);
    if (sel){
      sel.innerHTML = cams.map(d=>`<option value="${d.deviceId}">${d.label||'Camera'}</option>`).join("");
      const rear = pickRearCamera(cams);
      if (rear) sel.value = rear.deviceId;
    }
  }catch(_){}

  if (!isSecure()){
    showCamMsg(targetSel, "Site must be HTTPS or localhost for camera access. If on Replit, click the 'Open in new tab' button.", "error");
  }
  if (inIframe()){
    showCamMsg(targetSel, "If this is an embedded preview, your browser may block camera. Use the Open-in-New-Tab view.", "warn");
  }

  const engOrder = (engine==="auto")
    ? ["zxing","quagga"].concat(supportsNative() ? ["native"] : [])
    : [engine];

  try{
    await startWithEngine(engOrder[0], targetSel, sym, onAccept, engOrder);
  }catch(_){
    for (let i=1;i<engOrder.length;i++){
      try{ await startWithEngine(engOrder[i], targetSel, sym, onAccept, engOrder); break; }catch(__){}
    }
  }
}
function stopScanner(hide){
  hardStop(_currentTargetSel || "#scanner");
  if (hide) qs("#scanModal")?.classList.add("hidden");
}
function stopInlineScanner(){
  hardStop("#inline-view");
  qs("#inline-scan")?.classList.add("hidden");
}
function stopMass(hide){
  hardStop("#massView");
  if (hide) qs("#massModal")?.classList.add("hidden");
}

// ---- Snapshot decoder (multi-pass) ------------------------------------------
async function snapshotDecode(e, targetSel){
  if (e) e.preventDefault();
  const v = qs(`${targetSel} video`);
  if (!v || !v.videoWidth) { alert("Camera not ready yet."); return; }

  const canvas = document.createElement("canvas");
  canvas.width = v.videoWidth; canvas.height = v.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

  const sym = (qs("#symbology")?.value) || (qs("#inlineSymbology")?.value) || (qs("#massSymbology")?.value) || "code128";
  const passes = [
    img => img,                               // raw
    img => threshold(img, 160),               // thresholded
    img => invert(img),                       // inverted
    img => unsharp(img, 0.6, 1)               // slight sharpen
  ];

  for (const pass of passes){
    const processed = pass(canvas);
    const code = await decodeCanvas(processed, sym);
    if (code){ routeSnapshotCode(code); return; }
  }
  alert("No barcode detected in snapshot. Try zoom/flash, or move closer.");
}
function threshold(c, t){
  const ctx = c.getContext("2d");
  const img = ctx.getImageData(0,0,c.width,c.height);
  const d = img.data;
  for(let i=0;i<d.length;i+=4){
    const g = 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
    const v = g < t ? 0 : 255;
    d[i]=d[i+1]=d[i+2]=v;
  }
  ctx.putImageData(img,0,0); return c;
}
function invert(c){
  const ctx = c.getContext("2d");
  const img = ctx.getImageData(0,0,c.width,c.height);
  const d = img.data;
  for(let i=0;i<d.length;i+=4){
    d[i]=255-d[i]; d[i+1]=255-d[i+1]; d[i+2]=255-d[i+2];
  }
  ctx.putImageData(img,0,0); return c;
}
function unsharp(c, amount=0.6, radius=1){
  const ctx = c.getContext("2d");
  const img = ctx.getImageData(0,0,c.width,c.height);
  const d = img.data, out = new Uint8ClampedArray(d.length);
  const w=c.width,h=c.height, idx=(x,y)=>((y*w+x)<<2);
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      let r=0,g=0,b=0;
      for(let yy=-1;yy<=1;yy++){
        for(let xx=-1;xx<=1;xx++){
          const i = idx(x+xx,y+yy);
          r+=d[i]; g+=d[i+1]; b+=d[i+2];
        }
      }
      const i2 = idx(x,y);
      const br=r/9, bg=g/9, bb=b/9;
      out[i2]   = clamp(d[i2]   + (d[i2]   - br)*amount);
      out[i2+1] = clamp(d[i2+1] + (d[i2+1] - bg)*amount);
      out[i2+2] = clamp(d[i2+2] + (d[i2+2] - bb)*amount);
      out[i2+3] = d[i2+3];
    }
  }
  for(let i=0;i<d.length;i++) d[i]=out[i]||d[i];
  ctx.putImageData(img,0,0); return c;
}
function clamp(v){ return v<0?0:(v>255?255:v); }
async function decodeCanvas(canvas, sym){
  if (supportsNative()){
    try{
      const det = new window.BarcodeDetector({ formats: buildFormats(sym) });
      const res = await det.detect(canvas);
      if (res && res[0] && res[0].rawValue) return String(res[0].rawValue).trim();
    }catch(_){}
  }
  if (window.ZXing){
    try{
      const Z = window.ZXing;
      const reader = new Z.BrowserMultiFormatReader(buildZXHints(sym));
      const res = await reader.decodeFromCanvas(canvas);
      if (res && res.getText) return String(res.getText()).trim();
    }catch(_){}
  }
  return null;
}
function routeSnapshotCode(code){
  if (!qs("#scanModal")?.classList.contains("hidden")){
    if (_assignOverlay){
      stopScanner(true);
      const inp = qs('#form-edit input[name="barcode"]'); if (inp){ inp.value = code; }
      alert(`Barcode captured: ${code}`);
    } else {
      stopScanner(true);
      manualLookupWithValue(code);
    }
  } else if (!qs("#massModal")?.classList.contains("hidden")){
    assignMass(code);
  } else if (!qs("#modal")?.classList.contains("hidden")){
    const inp = qs('#form-edit input[name="barcode"]'); if (inp){ inp.value = code; }
    stopInlineScanner();
    alert(`Barcode captured: ${code}`);
  }
}

// ===== Products page logic ====================================================
if (window.INVENT_WAREHOUSE){
  const wh = window.INVENT_WAREHOUSE;
  const listEl = qs("#cards");
  const stock = qs("#stock");
  const sortSel = qs("#sort");
  const search = qs("#search");
  let data = [];
  let filtered = [];
  let currentIndex = null;

  async function fetchProducts(){
    const params = new URLSearchParams();
    if (stock.value) params.set("stock", stock.value);
    if (sortSel.value) params.set("sort", sortSel.value);
    const {data: resp} = await apiGet(`/api/warehouse/${encodeURIComponent(wh)}/products?`+params.toString());
    data = resp.products || [];
    render();
  }
  function statusBadge(p){
    const qty = +p.qty||0, mn=+p.min||0, mx=+p.max||0;
    if (qty < mn) return `<span class="badge low">Low Stock</span>`;
    if (qty > mx) return `<span class="badge high">Over Max</span>`;
    return `<span class="badge ok">Optimal</span>`;
  }
  function render(){
    const s = (search.value||"").trim().toLowerCase();
    filtered = data.filter(p => {
      if (!s) return true;
      return [p.internal_name,p.customer_name,p.bin,p.internal_code,p.customer_code,p.barcode]
        .some(v => (v||"").toLowerCase().includes(s));
    });
    listEl.innerHTML = filtered.map((p,i)=>`
      <div class="inv-card" onclick="openProduct(${i})">
        <div class="inv-head">
          <i class="ti ti-package"></i>
          <div style="flex:1">
            <div><b>${p.internal_name||""}</b></div>
            <div class="muted">${p.customer_name||""}</div>
          </div>
          ${statusBadge(p)}
        </div>
        <div class="kv">Bin: <b>${p.bin||"-"}</b></div>
        <div class="kv">Qty: <b>${p.qty||0}</b> · Min: <b>${p.min||0}</b> · Max: <b>${p.max||0}</b></div>
        <div class="kv">Barcode: <b>${p.barcode||"—"}</b></div>
      </div>
    `).join("");
  }
  stock.addEventListener("change", fetchProducts);
  sortSel.addEventListener("change", fetchProducts);
  search.addEventListener("input", render);
  fetchProducts();

  // ---- Add / open product ---------------------------------------------------
  window.openAddProduct = function(){
    currentIndex = null;
    openModal({
      internal_name:"", customer_name:"", internal_code:"", customer_code:"",
      bin:"", qty:0, min:0, max:0, barcode:""
    });
  }
  window.openProduct = function(i){
    const p = filtered[i];
    const idx = data.findIndex(x => x === p);
    currentIndex = idx;
    openModal(p);
  }
  function openModal(p){
    qs("#modal").classList.remove("hidden");
    qs("#m-title").textContent = p.internal_name || "Product";
    const form = qs("#form-edit");
    form.innerHTML = `
      <label>Internal Product Name<input name="internal_name" value="${p.internal_name||""}"></label>
      <label>Customer Product Name<input name="customer_name" value="${p.customer_name||""}"></label>
      <div class="row">
        <label style="flex:1">Bin<input name="bin" value="${p.bin||""}"></label>
        <label style="flex:1">Barcode<input name="barcode" value="${p.barcode||""}"></label>
      </div>
      <div class="row">
        <label style="flex:1">Qty<input type="number" name="qty" value="${p.qty||0}"></label>
        <label style="flex:1">Min<input type="number" name="min" value="${p.min||0}"></label>
        <label style="flex:1">Max<input type="number" name="max" value="${p.max||0}"></label>
      </div>
    `;
  }
  window.closeModal = function(e){
    if (e && e.preventDefault) e.preventDefault();
    try { stopInlineScanner(); } catch(_){}
    const modal = document.getElementById('modal');
    if (modal){
      modal.querySelectorAll('video').forEach(v=>{
        try{ v.srcObject && v.srcObject.getTracks().forEach(t=>t.stop()); }catch(_){}
        try{ v.srcObject = null; }catch(_){}
      });
      const inline = modal.querySelector('#inline-view');
      if (inline) inline.innerHTML = '';
      modal.classList.add('hidden');
    }
  }
  document.addEventListener('keydown', (ev)=>{
    if (ev.key === 'Escape'){
      const modal = document.getElementById('modal');
      if (modal && !modal.classList.contains('hidden')) closeModal(ev);
      const scan = document.getElementById('scanModal');
      if (scan && !scan.classList.contains('hidden')) stopScanner(true);
      const mass = document.getElementById('massModal');
      if (mass && !mass.classList.contains('hidden')) stopMass(true);
    }
  });

  window.saveProduct = async function(e){
    e.preventDefault();
    const fd = new FormData(qs("#form-edit"));
    const obj = Object.fromEntries(fd.entries());
    ["qty","min","max"].forEach(k=>obj[k]=obj[k]===""?0:parseInt(obj[k],10));
    if (currentIndex == null){
      const {data:resp} = await apiPost(`/api/warehouse/${encodeURIComponent(wh)}/products`, obj);
      if (resp.ok){ closeModal(); fetchProducts(); }
      else alert(resp.error||"Failed");
    } else {
      const {data:resp} = await apiPut(`/api/warehouse/${encodeURIComponent(wh)}/products/${currentIndex}`, obj);
      if (resp.ok){ closeModal(); fetchProducts(); }
      else alert(resp.error||"Failed");
    }
  }
  window.deleteProduct = async function(e){
    e.preventDefault();
    if (currentIndex==null) { closeModal(); return; }
    if (!confirm("Delete this product?")) return;
    if (!confirm("Really delete? This cannot be undone.")) return;
    const {data:resp} = await apiDel(`/api/warehouse/${encodeURIComponent(wh)}/products/${currentIndex}`);
    if (resp.ok){ closeModal(); fetchProducts(); }
    else alert(resp.error||"Failed");
  }

  // ---- Scanner (modal) ------------------------------------------------------
  window.openScannerModal = async function(){
    _assignOverlay = false; // lookup mode
    qs("#scanModal").classList.remove("hidden");
    const sym = (qs("#symbology")?.value) || "code128";
    const eng = (qs("#engine")?.value) || "zxing";
    await startScanner("#scanner", async (code)=>{
      stopScanner(true);
      const {data:resp} = await apiGet(`/api/warehouse/${encodeURIComponent(wh)}/by_barcode?code=${encodeURIComponent(code)}`);
      if (resp.index == null){
        alert(`No product with barcode ${code}. Open a product and use 'Scan Barcode' to assign.`);
      }else{
        currentIndex = resp.index;
        openModal(resp.product);
      }
    }, sym, eng);
  };

  // NEW: open overlay scanner *over* product modal to assign barcode
  window.openAssignScanner = async function(e){
    if (e) e.preventDefault();
    _assignOverlay = true;
    qs("#scanModal").classList.remove("hidden");
    const sym = (qs("#symbology")?.value) || "code128";
    const eng = (qs("#engine")?.value) || "zxing";
    await startScanner("#scanner", (code)=>{
      stopScanner(true);              // hide overlay
      const inp = qs('#form-edit input[name="barcode"]');
      if (inp) inp.value = code;      // fill product’s barcode
      alert(`Barcode captured: ${code}`);
    }, sym, eng);
  };

  function manualLookupWithValue(code){
    apiGet(`/api/warehouse/${encodeURIComponent(wh)}/by_barcode?code=${encodeURIComponent(code)}`)
      .then(({data:resp})=>{
        if (resp.index == null) alert("No product with that barcode.");
        else { currentIndex = resp.index; openModal(resp.product); }
      });
  }
  window.manualLookup = function(){
    const code = qs("#manualCode").value.trim();
    if (!code) return;
    if (_assignOverlay){
      stopScanner(true);
      const inp = qs('#form-edit input[name="barcode"]');
      if (inp) inp.value = code;
      alert(`Barcode captured: ${code}`);
    } else {
      stopScanner(true);
      manualLookupWithValue(code);
    }
  };

  // ---- Inline scanner (still available) -------------------------------------
  window.startInlineScanner = async function(e){
    e.preventDefault();
    qs("#inline-scan").classList.remove("hidden");
    const sym = (qs("#inlineSymbology")?.value) || "code128";
    const eng = (qs("#inlineEngine")?.value) || "zxing";
    await startScanner("#inline-view", (code)=>{
      qs('#form-edit input[name="barcode"]').value = code;
      stopInlineScanner();
      alert(`Barcode captured: ${code}`);
    }, sym, eng);
  }
  window.stopInlineScanner = stopInlineScanner;

  // ---- Mass barcode ---------------------------------------------------------
  let massList = []; let massPos = 0;
  window.openMassBarcode = async function(){
    const {data:resp} = await apiGet(`/api/warehouse/${encodeURIComponent(wh)}/unbarcoded`);
    massList = resp.items || []; massPos = 0;
    if (massList.length === 0){ alert("All products already have barcodes."); return; }
    qs("#massModal").classList.remove("hidden");
    updateMassHead();
    const sym = (qs("#massSymbology")?.value) || "code128";
    const eng = (qs("#massEngine")?.value) || "zxing";
    await startScanner("#massView", (code)=>assignMass(code), sym, eng);
  }
  function updateMassHead(){
    const cur = massList[massPos];
    qs("#massName").textContent = cur?.product?.internal_name || "—";
    qs("#massBin").textContent  = cur?.product?.bin || "—";
  }
  async function assignMass(code){
    const cur = massList[massPos];
    await apiPut(`/api/warehouse/${encodeURIComponent(wh)}/products/${cur.index}`, {barcode: code});
    massPos++;
    if (massPos >= massList.length){
      stopMass(true); alert("Mass barcode assignment complete.");
      fetchProducts(); return;
    }
    updateMassHead();
  }
  window.massManualAssign = function(){
    const code = qs("#massManual").value.trim();
    if (!code) return;
    assignMass(code); qs("#massManual").value="";
  }

  // expose globals for buttons
  window.toggleTorch = toggleTorch;
  window.stopMass = stopMass;
  window.stopScanner = stopScanner;
  window.snapshotDecode = snapshotDecode;
  window.afFocus = (e, sel)=>doAutofocus(e, sel);
}
