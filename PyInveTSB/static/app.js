// ---- Small helper ----
function qs(s, el=document){return el.querySelector(s)}
function qsa(s, el=document){return [...el.querySelectorAll(s)]}
function apiGet(url){return axios.get(url)}
function apiPost(url, data){return axios.post(url, data)}
function apiPut(url, data){return axios.put(url, data)}
function apiDel(url){return axios.delete(url)}

// ===== Scanner internals =====
let _scannerRunning = false;
let _currentTargetSel = null;
let _activeTrack = null;
let _torchOn = false;
let _zxingReader = null;
let _zxingCtrl = null;
let _nativeLoop = null;

function buildFormats(sym){
  if (sym === "code128") return ["code_128","ean_13","upc_a","upc_e","ean_8"]; // include close cousins for robustness
  if (sym === "upcean")  return ["upc_a","upc_e","ean_13","ean_8"];
  return ["code_128","upc_a","upc_e","ean_13","ean_8"];
}

function buildZXFormats(sym){
  const Z = window.ZXing;
  if (!Z) return [];
  const map = {
    code_128: Z.BarcodeFormat.CODE_128,
    ean_13:   Z.BarcodeFormat.EAN_13,
    ean_8:    Z.BarcodeFormat.EAN_8,
    upc_a:    Z.BarcodeFormat.UPC_A,
    upc_e:    Z.BarcodeFormat.UPC_E
  };
  return buildFormats(sym).map(f => map[f]).filter(Boolean);
}

function buildZXHints(sym){
  const Z = window.ZXing;
  if (!Z) return null;
  const hints = new Map();
  const formats = buildZXFormats(sym);
  if (formats.length){
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, formats);
  }
  // More aggressive try-harder for damaged codes
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  return hints;
}

function avgErr(res){
  const arr = (res && res.codeResult && res.codeResult.decodedCodes) || [];
  const errs = arr.map(c => c.error).filter(e => typeof e === "number");
  if (!errs.length) return 1;
  const s = errs.reduce((a,b)=>a+b,0);
  return s/errs.length;
}

function hardStop(targetSel){
  try{ Quagga.offDetected(); Quagga.offProcessed(); Quagga.stop(); }catch(e){}
  if (_zxingCtrl){ try{ _zxingCtrl.stop(); }catch(e){} _zxingCtrl = null; }
  if (_zxingReader){ try{ _zxingReader.reset(); }catch(e){} _zxingReader = null; }
  if (_nativeLoop){ cancelAnimationFrame(_nativeLoop); _nativeLoop = null; }
  // Clear target DOM
  if (targetSel){
    const t = document.querySelector(targetSel);
    if (t) t.innerHTML = "";
  }
  // Stop all camera tracks
  qsa("video").forEach(v=>{
    try{ if (v.srcObject) v.srcObject.getTracks().forEach(tr=>tr.stop()); }catch(e){}
  });
  _scannerRunning = false;
  _currentTargetSel = null;
  _activeTrack = null;
  _torchOn = false;
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

async function applyZoomUI(targetSel){
  const rangeId = (targetSel==="#scanner")? "#zoomRange" : (targetSel==="#inline-view")? "#inlineZoom" : "#massZoom";
  const range = qs(rangeId);
  if (!range) return;
  const track = getActiveTrack();
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
    try{ await track.applyConstraints({ advanced: [{ zoom: parseFloat(e.target.value) }] }); }catch(err){}
  };
}

function getActiveTrack(){
  try {
    if (_currentTargetSel){
      const v = qs(`${_currentTargetSel} video`);
      if (v && v.srcObject) return v.srcObject.getVideoTracks()[0] || null;
    }
    const v2 = qs("video");
    if (v2 && v2.srcObject) return v2.srcObject.getVideoTracks()[0] || null;
  } catch(e){}
  return null;
}

async function setTorch(on){
  const track = getActiveTrack();
  if (!track) return false;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if (!caps.torch) return false;
  try{
    await track.applyConstraints({ advanced: [{ torch: !!on }] });
    _torchOn = !!on;
    return true;
  }catch(e){ return false; }
}
async function toggleTorch(e){
  if (e) e.preventDefault();
  const ok = await setTorch(!_torchOn);
  if (!ok) alert("Flash not supported on this device/browser.");
}

// ===== Engines =====
function supportsNative(){
  try {
    // Must be a real constructor with a detect() method on the prototype
    if (typeof window.BarcodeDetector !== 'function') return false;
    const det = new window.BarcodeDetector({ formats: ['code_128'] });
    return !!(det && typeof det.detect === 'function');
  } catch (e) {
    return false;
  }
}


async function startNative(targetSel, sym, onAccept){
  const formats = buildFormats(sym);
  const detector = new window.BarcodeDetector({ formats });
  const v = ensureVideo(targetSel);
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 }, height: { ideal: 1080 },
      advanced: [{ focusMode: "continuous" }]
    },
    audio: false
  });
  v.srcObject = stream;
  await v.play();
  _activeTrack = getActiveTrack();
  await applyZoomUI(targetSel);

  let buf = []; const MAX=6, NEED=2;
  const loop = async ()=>{
    if (!_scannerRunning) return;
    try{
      const results = await detector.detect(v);
      for (const r of results){
        const code = String(r.rawValue||"").trim();
        if (!code) continue;
        // If sym strictly numeric (upcean) and code has letters, skip
        if (sym === "upcean" && /[^\d]/.test(code)) continue;
        buf.push(code); if (buf.length>MAX) buf.shift();
        const counts = {}; buf.forEach(c=>counts[c]=(counts[c]||0)+1);
        const best = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
        if (best && best[1] >= NEED){
          setTimeout(()=>onAccept(best[0]), 10);
          buf = [];
        }
      }
    }catch(e){}
    _nativeLoop = requestAnimationFrame(loop);
  };
  _nativeLoop = requestAnimationFrame(loop);
}

async function startZXing(targetSel, sym, onAccept){
  const Z = window.ZXing;
  const v = ensureVideo(targetSel);
  _zxingReader = new Z.BrowserMultiFormatReader(buildZXHints(sym));
  _zxingCtrl = await _zxingReader.decodeFromVideoDevice(
    undefined, // default camera
    v,
    (result, err)=>{
      if (!_scannerRunning) return;
      if (result && result.getText){
        onAccept(String(result.getText()).trim());
      }
    }
  );
  _activeTrack = getActiveTrack();
  await applyZoomUI(targetSel);
}

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
        width: { ideal: 1920 }, height: { ideal: 1080 }
      },
      area: { top: "15%", right: "10%", left: "10%", bottom: "15%" }
    },
    locator: { patchSize: "large", halfSample: false },
    numOfWorkers: navigator.userAgent.includes("Safari") ? 0 : 2,
    frequency: 8,
    decoder: { readers },
    locate: true
  };
}

async function startQuagga(targetSel, sym, onAccept){
  Quagga.init(quaggaConfig(targetSel, sym), function(err){
    if (err){ console.log(err); return; }
    Quagga.start(); _scannerRunning = true;
    _activeTrack = getActiveTrack();
    applyZoomUI(targetSel);
  });

  // Consensus filter
  let windowCodes = []; const MAX_WINDOW = 6, NEED_MATCHES = 2;
  Quagga.onDetected((res)=>{
    const cr = res && res.codeResult;
    const code = (cr && cr.code) ? String(cr.code).trim() : "";
    const fmt  = cr && cr.format;
    if (avgErr(res) > 0.25) return; // slightly looser to accept rough labels
    if (sym === "code128" && fmt !== "code_128") return;
    if (sym === "upcean"  && !["upc","upc_e","ean","ean_8"].includes(String(fmt).replace("-","_"))) return;
    if (!code) return;
    windowCodes.push(code); if (windowCodes.length>MAX_WINDOW) windowCodes.shift();
    const counts = {}; windowCodes.forEach(c=>counts[c]=(counts[c]||0)+1);
    const best = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    if (best && best[1] >= NEED_MATCHES){
      setTimeout(()=>onAccept(best[0]), 30);
      windowCodes = [];
    }
  });
}

// ---- Master start/stop ----
async function startScanner(targetSel, onAccept, sym="code128", engine="auto"){
  if (_scannerRunning) return;
  hardStop(targetSel); // clean slate
  _currentTargetSel = targetSel;
  _scannerRunning = true;

  const pick = (engine === "auto")
    ? (supportsNative() ? "native" : (window.ZXing && window.ZXing.BrowserMultiFormatReader ? "zxing" : "quagga"))
    : engine;

  try {
    if (pick === "native") {
      if (!supportsNative()) throw new Error("Native unsupported");
      await startNative(targetSel, sym, onAccept);
    } else if (pick === "zxing") {
      if (!(window.ZXing && window.ZXing.BrowserMultiFormatReader)) throw new Error("ZXing unavailable");
      await startZXing(targetSel, sym, onAccept);
    } else {
      await startQuagga(targetSel, sym, onAccept);
    }
  } catch (err) {
    // Be quiet in production; just fall back gracefully
    if (window.ZXing && window.ZXing.BrowserMultiFormatReader) {
      try { await startZXing(targetSel, sym, onAccept); return; } catch (_e) {}
    }
    await startQuagga(targetSel, sym, onAccept);
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

// ---- Snapshot decode (for tiny/smudged) ----
async function snapshotDecode(e, targetSel){
  if (e) e.preventDefault();
  const v = qs(`${targetSel} video`);
  if (!v || !v.videoWidth) { alert("Camera not ready yet."); return; }

  // Draw full-res frame to canvas
  const c = document.createElement("canvas");
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, c.width, c.height);

  // Try Native first
  if (supportsNative()){
    try{
      const det = new window.BarcodeDetector({ formats: buildFormats((qs("#symbology")?.value)||"code128") });
      const results = await det.detect(c);
      if (results && results[0]){
        const code = String(results[0].rawValue||"").trim();
        if (code){ acceptSnapshotCode(code); return; }
      }
    }catch(_){}
  }
  // Then ZXing (more tolerant)
  if (window.ZXing){
    try{
      const Z = window.ZXing;
      const reader = new Z.BrowserMultiFormatReader(buildZXHints((qs("#symbology")?.value)||"code128"));
      // Decode from data URL via Image element
      const img = new Image();
      img.src = c.toDataURL("image/png");
      await img.decode();
      const res = await reader.decodeFromImage(img);
      const code = res && res.getText ? String(res.getText()).trim() : "";
      if (code){ acceptSnapshotCode(code); return; }
    }catch(_){}
  }
  alert("No barcode detected in snapshot. Try zoom/flash, or move closer.");

  function acceptSnapshotCode(code){
    // Route to whichever modal is open
    if (!qs("#scanModal").classList.contains("hidden")){
      stopScanner(true);
      manualLookupWithValue(code);
    } else if (!qs("#massModal").classList.contains("hidden")){
      // Mass mode assign
      assignMass(code);
    } else if (!qs("#modal").classList.contains("hidden")){
      // Inline modal
      const inp = qs('#form-edit input[name="barcode"]'); if (inp){ inp.value = code; }
      stopInlineScanner();
      alert(`Barcode captured: ${code}`);
    }
  }
}

// ===== Products page logic =====
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

  // ---- Add product ----
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
        <label style="flex:1">Internal Product Code<input name="internal_code" value="${p.internal_code||""}"></label>
        <label style="flex:1">Customer Product Code<input name="customer_code" value="${p.customer_code||""}"></label>
      </div>
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

  window.closeModal = function(){
    qs("#modal").classList.add("hidden");
    stopInlineScanner();
  }

  document.addEventListener('keydown', (ev)=>{
    if (ev.key === 'Escape'){
      const modal = document.getElementById('modal');
      if (modal && !modal.classList.contains('hidden')){
        closeModal(ev);
      }
      // Also close the full-screen scanner if open
      const scan = document.getElementById('scanModal');
      if (scan && !scan.classList.contains('hidden') && typeof stopScanner === 'function'){
        stopScanner(true);
      }
      const mass = document.getElementById('massModal');
      if (mass && !mass.classList.contains('hidden') && typeof stopMass === 'function'){
        stopMass(true);
      }
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

  // ---- Scanner (modal) ----
  window.openScannerModal = function(){
    qs("#scanModal").classList.remove("hidden");
    const sym = (qs("#symbology")?.value) || "code128";
    const eng = (qs("#engine")?.value) || "native";
    startScanner("#scanner", async (code)=>{
      stopScanner(true);
      const {data:resp} = await apiGet(`/api/warehouse/${encodeURIComponent(wh)}/by_barcode?code=${encodeURIComponent(code)}`);
      if (resp.index == null){
        alert(`No product with barcode ${code}. Open a product and use 'Scan Barcode' to assign.`);
      }else{
        currentIndex = resp.index;
        openModal(resp.product);
      }
    }, sym, eng);
  }

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
    stopScanner(true);
    manualLookupWithValue(code);
  }

  // ---- Inline scanner (modal "Scan Barcode") ----
  window.startInlineScanner = function(e){
    e.preventDefault();
    qs("#inline-scan").classList.remove("hidden");
    const sym = (qs("#inlineSymbology")?.value) || "code128";
    const eng = (qs("#inlineEngine")?.value) || "native";
    startScanner("#inline-view", (code)=>{
      qs('#form-edit input[name="barcode"]').value = code;
      stopInlineScanner();
      alert(`Barcode captured: ${code}`);
    }, sym, eng);
  }
  window.stopInlineScanner = stopInlineScanner;

  // ---- Mass barcode assignment ----
  let massList = [];
  let massPos = 0;

  window.openMassBarcode = async function(){
    const {data:resp} = await apiGet(`/api/warehouse/${encodeURIComponent(wh)}/unbarcoded`);
    massList = resp.items || [];
    massPos = 0;
    if (massList.length === 0){
      alert("All products already have barcodes.");
      return;
    }
    qs("#massModal").classList.remove("hidden");
    updateMassHead();
    const sym = (qs("#massSymbology")?.value) || "code128";
    const eng = (qs("#massEngine")?.value) || "native";
    startScanner("#massView", (code)=>assignMass(code), sym, eng);
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
      fetchProducts();
      return;
    }
    updateMassHead();
  }

  window.massManualAssign = function(){
    const code = qs("#massManual").value.trim();
    if (!code) return;
    assignMass(code); qs("#massManual").value="";
  }

  // expose globals
  window.toggleTorch = toggleTorch;
  window.stopMass = stopMass;
  window.stopScanner = stopScanner;
  window.snapshotDecode = snapshotDecode;
}
