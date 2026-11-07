/* Compact supplier-receiving card. Each entry mode exposes only the inputs it needs. */
(function(){
  function activeReceiveMode(index,line){return S.receiveEntry?.index===index?S.receiveEntry.mode:(line.product.unitKind==='WEIGHT'?'WEIGHT':'LOOSE')}
  function priceInput(id,label,value,onchange){return `<div><label>${label}</label><input id="${id}" type="number" min="0" step=".01" value="${(Number(value||0)/100).toFixed(2)}" onchange="${onchange}"></div>`}
  function quantityInput(id,label,value,step,onchange){return `<div><label>${label}</label><input id="${id}" type="number" min="0" step="${step}" value="${Number(value||0)}" onchange="${onchange}"></div>`}
  function entryEditor(line,index,mode){
    const pack=receiptPack(line.product),weighted=line.product.unitKind==='WEIGHT';
    if(weighted||mode==='WEIGHT')return `<div class="receive-entry-panel"><div class="entry-caption">⚖️ إدخال بالكيلو</div><div class="packing-grid compact-grid">${quantityInput(`reQty${index}`,'الكمية بالكيلو',line.kilos,'.001',`editLine(${index},'kilos',this.value)`)}${priceInput(`reCost${index}`,'شراء الكيلو',line.costKilo,`editLine(${index},'costKilo',this.value)`)}${priceInput(`reSell${index}`,'بيع الكيلو',line.sell,`editLine(${index},'sell',this.value)`)}</div></div>`;
    if(mode==='CARTON')return `<div class="receive-entry-panel"><div class="entry-caption">📦 إدخال كراتين</div><div class="packing-grid compact-grid">${quantityInput(`reCartons${index}`,'عدد الكراتين',line.cartons,'1',`editLine(${index},'cartons',this.value)`)}<div><label>القطع في الكرتونة</label><input id="reCartonSize${index}" type="number" min="2" value="${pack.carton>1?pack.carton:''}" placeholder="مثال: 24" ${pack.carton>1?'readonly':''}></div>${priceInput(`reCostCarton${index}`,'شراء الكرتونة',line.costCarton,`editLine(${index},'costCarton',this.value)`)}${priceInput(`reSellPiece${index}`,'بيع القطعة',line.sell,`editLine(${index},'sell',this.value)`)}</div>${pack.carton<2?`<button class="btn outline full" style="margin-top:8px" onclick="saveReceiptPackaging(${index},'CARTON')">✓ حفظ سعة الكرتونة وتوليد باركودها تلقائيًا</button>`:''}</div>`;
    if(mode==='BAG')return `<div class="receive-entry-panel"><div class="entry-caption">🛍️ إدخال أكياس</div><div class="packing-grid compact-grid">${quantityInput(`reBags${index}`,'عدد الأكياس',line.bags,'1',`editLine(${index},'bags',this.value)`)}<div><label>القطع في الكيس</label><input id="reBagSize${index}" type="number" min="2" value="${pack.bag||''}" placeholder="مثال: 6" ${pack.bag>1?'readonly':''}></div>${priceInput(`reCostBag${index}`,'شراء الكيس',line.costBag,`editLine(${index},'costBag',this.value)`)}${priceInput(`reSellPiece${index}`,'بيع القطعة',line.sell,`editLine(${index},'sell',this.value)`)}</div>${pack.bag<2?`<button class="btn outline full" style="margin-top:8px" onclick="saveReceiptPackaging(${index},'PACKAGE')">✓ حفظ سعة الكيس وتوليد باركوده تلقائيًا</button>`:''}</div>`;
    return `<div class="receive-entry-panel"><div class="entry-caption">🧺 إدخال فرط</div><div class="packing-grid compact-grid">${quantityInput(`reLoose${index}`,'عدد القطع',line.loose,'1',`editLine(${index},'loose',this.value)`)}${priceInput(`reCostLoose${index}`,'شراء القطعة',line.costLoose,`editLine(${index},'costLoose',this.value)`)}${priceInput(`reSellPiece${index}`,'بيع القطعة',line.sell,`editLine(${index},'sell',this.value)`)}</div></div>`;
  }
  function barcodeControls(line,index){
    if(line.product.unitKind==='WEIGHT')return `<div class="barcode-actions compact-actions"><button class="btn muted" onclick="openReceiveProduct(${index})">✏️ تعديل تفاصيل صنف الوزن</button></div>`;
    return `<div class="barcode-actions compact-actions"><button class="btn outline" onclick="scanExistingPackaging(${index},'CARTON')">📷 باركود الكرتونة</button><button class="btn outline" onclick="scanExistingPackaging(${index},'PACKAGE')">📷 باركود الكيس</button><button class="btn muted" onclick="openReceiveProduct(${index})">✏️ بطاقة الصنف</button></div>`;
  }
  lineCard=function(line,index){
    const product=line.product,pack=receiptPack(product),weighted=product.unitKind==='WEIGHT';
    const mappings=product.barcodeMappings||[], cartonCode=mappings.find(x=>x.saleUnit==='CARTON')?.barcode||'', bagCode=mappings.find(x=>x.saleUnit==='PACKAGE')?.barcode||'';
    const mode=activeReceiveMode(index,line), quantity=weighted?`${Number(line.kilos||0).toLocaleString('ar-EG')} كجم`:`${receiptPieceCount(line).toLocaleString('ar-EG')} قطعة`;
    const cartDisabled=weighted, bagDisabled=weighted;
    return `<article class="line receive-line compact-receive"><div class="receive-line-head"><div><b>${esc(product.nameAr)}</b><div class="sub">${esc(product.barcodes?.[0]||'بدون باركود')} • ${weighted?'صنف موزون':'قطعة / عبوة'}</div></div><button class="btn danger mini-delete" onclick="removeLine(${index})" aria-label="حذف">🗑️</button></div><div class="receive-stats"><div class="receive-stat"><small>الإجمالي</small><b>${quantity}</b></div><div class="receive-stat"><small>شراء السطر</small><b>${money(receiptLineTotal(line))}</b></div><div class="receive-stat"><small>بيع الوحدة</small><b>${money(line.sell)}</b></div></div><div class="entry-buttons entry-buttons-four"><button class="${mode==='CARTON'?'active':''}" ${cartDisabled?'disabled':''} onclick="selectReceiveEntry(${index},'CARTON')">+ كرتونة</button><button class="${mode==='LOOSE'?'active':''}" ${weighted?'disabled':''} onclick="selectReceiveEntry(${index},'LOOSE')">+ فرط</button><button class="${mode==='BAG'?'active':''}" ${bagDisabled?'disabled':''} onclick="selectReceiveEntry(${index},'BAG')">+ كيس</button><button class="${mode==='WEIGHT'?'active':''}" ${weighted?'':'disabled'} onclick="selectReceiveEntry(${index},'WEIGHT')">+ كيلو</button></div><div class="mode-help">${esc(receiptMixText(line))}</div>${entryEditor(line,index,mode)}<details class="receive-details"><summary>⌄ تعديل متقدم: الكميات والأسعار والصلاحية</summary><div class="packing-grid compact-grid receive-advanced"><div><label>تاريخ الصلاحية (اختياري)</label><input type="date" value="${line.expiry||''}" onchange="editLine(${index},'expiry',this.value)"></div>${weighted?'':`<div><label>سعة الكرتونة</label><input value="${pack.carton} قطعة" readonly></div><div><label>سعة الكيس</label><input value="${pack.bag?`${pack.bag} قطعة`:'غير مُعرّف'}" readonly></div><div><label>باركود الكرتونة</label><input value="${esc(cartonCode||'غير مسجل')}" readonly></div><div><label>باركود الكيس</label><input value="${esc(bagCode||'غير مسجل')}" readonly></div>`}<div class="wide receipt-line-total">إجمالي السطر: ${money(receiptLineTotal(line))}</div></div></details>${barcodeControls(line,index)}</article>`;
  };
  selectReceiveEntry=function(index,mode){
    const line=S.lines[index];if(!line)return;
    const pack=receiptPack(line.product);
    if(mode==='WEIGHT'&&line.product.unitKind!=='WEIGHT')return;
    if(mode!=='WEIGHT'&&line.product.unitKind==='WEIGHT')return;
    S.receiveEntry={index,mode};render();
  };
  saveReceiptPackaging=async function(index,kind){
    const line=S.lines[index],product=line?.product;if(!product)return;
    const carton=kind==='CARTON'?Math.max(2,Number(document.getElementById(`reCartonSize${index}`)?.value)||0):Math.max(1,Number(product.purchasePackSize)||1);
    const bag=kind==='PACKAGE'?Math.max(2,Number(document.getElementById(`reBagSize${index}`)?.value)||0):Math.max(0,Number(product.retailPackage?.unitsPerPackage)||0);
    if((kind==='CARTON'&&carton<2)||(kind==='PACKAGE'&&bag<2))return flash('اكتب عدد قطع صحيحًا أولًا','err');
    try{
      busy(true);
      const mappings=[...(product.barcodeMappings||[])].filter(x=>x.saleUnit!=='CARTON'&&x.saleUnit!=='PACKAGE');
      const cartonMapping=(product.barcodeMappings||[]).find(x=>x.saleUnit==='CARTON');
      const bagMapping=(product.barcodeMappings||[]).find(x=>x.saleUnit==='PACKAGE');
      const cartonBarcode=cartonMapping?.barcode||(kind==='CARTON'?(await command('POST','/v1/product-barcodes/generate',{})).barcode:'');
      const bagBarcode=bagMapping?.barcode||(kind==='PACKAGE'?(await command('POST','/v1/product-barcodes/generate',{})).barcode:'');
      if(cartonBarcode)mappings.push({barcode:cartonBarcode,saleUnit:'CARTON'});
      if(bagBarcode)mappings.push({barcode:bagBarcode,saleUnit:'PACKAGE'});
      const payload={nameAr:product.nameAr,category:product.category,description:product.description||'',priceMinor:product.priceMinor,wholesalePriceMinor:product.wholesalePriceMinor||0,purchasePackSize:carton,cartonPriceMinor:carton>1?(product.cartonPriceMinor||product.priceMinor*carton):null,cartonContentsUnit:carton>1?'PIECE':null,retailPackage:bag>=2?{unitsPerPackage:bag,packagePriceMinor:product.retailPackage?.packagePriceMinor||product.priceMinor*bag,contentsUnit:'PIECE',label:'PACKAGE'}:null,barcodeMappings:mappings,mergeLegacyProducts:true,availableQtyMilli:product.availableQtyMilli,expectedStockVersion:product.stockVersion??product.version??0};
      await command('PUT',`/v1/products/${product.id}`,payload);
      const reloaded=await native('search',product.nameAr),fresh=(reloaded.products||[]).find(item=>item.id===product.id);
      if(!fresh)throw new Error('تم الحفظ؛ أعد البحث عن الصنف');
      line.product=fresh;
      if(kind==='CARTON'){line.costCarton=line.costCarton||line.costLoose*carton;line.cartons=Math.max(1,Number(line.cartons)||0)}else{line.costBag=line.costBag||line.costLoose*bag;line.bags=Math.max(1,Number(line.bags)||0)}
      flash(`تم حفظ ${kind==='CARTON'?'الكرتونة':'الكيس'} وتوليد باركوده تلقائيًا`);render();
    }catch(error){flash(error.message,'err')}finally{busy(false)}
  };
  openReceiveProduct=function(index){const line=S.lines[index];if(!line)return;S.productDetail=line.product;go('productDetail')};
})();
