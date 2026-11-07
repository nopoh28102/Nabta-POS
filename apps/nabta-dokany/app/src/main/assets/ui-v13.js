/* v1.3 mobile UI: presentation only; all financial mutations remain in Nabta APIs. */
(function(){
  const emoji={sale:'🛒',receive:'📦',stock:'📦',expiry:'⏳',debt:'💳',expense:'💸',report:'📊',scan:'📷',invoice:'🧾'};
  appIcon=function(kind){return `<span class="emoji-icon" aria-hidden="true">${emoji[kind]||'📦'}</span>`};
  const escXml=value=>String(value??'').replace(/[<>&'\"]/g,c=>({ '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;' }[c]));
  const num=value=>Number(value||0);
  const shortMoney=value=>(num(value)/100).toLocaleString('ar-EG',{minimumFractionDigits:2,maximumFractionDigits:2})+' ج';
  const today=()=>new Date().toISOString().slice(0,10);
  const safeText=value=>esc(value??'');

  function decorateUiV13(){
    const nav={home:'🏠',products:'📦',sale:'🛒',customers:'💳',reports:'📊',settings:'⚙️'};
    document.querySelectorAll('[data-nav]').forEach(button=>{
      if(!button.querySelector('.nav-emoji'))button.insertAdjacentHTML('afterbegin',`<span class="nav-emoji" aria-hidden="true">${nav[button.dataset.nav]||'•'}</span>`);
    });
    document.querySelectorAll('input:not([list])').forEach(input=>{
      input.autocomplete='off';
      input.spellcheck=false;
      input.autocapitalize='off';
    });
  }
  const priorRender=render;
  render=function(){priorRender();decorateUiV13()};

  customersView=function(){
    const query=(S.customerQuery||'').trim().toLocaleLowerCase('ar-EG');
    const debtOnly=S.debtOnly!==false;
    const customers=(S.customers||[]).filter(c=>{
      const hay=`${c.name||''} ${c.phone||''}`.toLocaleLowerCase('ar-EG');
      return (!query||hay.includes(query))&&(!debtOnly||num(c.balanceMinor)>0);
    }).sort((a,b)=>num(b.balanceMinor)-num(a.balanceMinor));
    const newForm=S.showDebtCustomer?`<div class="new-form"><div class="title">➕ عميل جديد ومديونية افتتاحية</div><div class="sub">اكتب المديونية القديمة إن وُجدت؛ يمكن تركها صفرًا.</div><div class="grid g2" style="margin-top:8px"><div><label>اسم العميل</label><input id="dcName" placeholder="الاسم"></div><div><label>الهاتف</label><input id="dcPhone" inputmode="tel" placeholder="اختياري"></div><div><label>دين قديم بالجنيه</label><input id="dcOpening" type="number" min="0" step=".01" value="0"></div><div><label>حد آجل اختياري</label><input id="dcLimit" type="number" min="0" step=".01" value="0"></div></div><div class="g2 grid" style="margin-top:8px"><button class="btn green" onclick="saveDebtCustomer()">✓ حفظ العميل</button><button class="btn muted" onclick="S.showDebtCustomer=false;render()">إلغاء</button></div></div>`:'';
    const collection=S.collectingCustomer?`<div class="new-form"><div class="title">💰 سداد: ${safeText(S.collectingCustomer.name)}</div><div class="g2 grid" style="margin-top:8px"><div><label>قيمة السداد بالجنيه</label><input id="dcPay" type="number" min=".01" step=".01" autofocus></div><div><label>ملاحظة</label><input id="dcPayNote" placeholder="سداد نقدي مثلاً"></div></div><div class="g2 grid" style="margin-top:8px"><button class="btn green" onclick="payCustomerDebt()">✓ تسجيل السداد</button><button class="btn muted" onclick="S.collectingCustomer=null;render()">إلغاء</button></div></div>`:'';
    view(`<div class="card"><div class="report-head"><div><div class="title">💳 ديون العملاء والسداد</div><div class="sub">ابحث، أضف عميلًا جديدًا أو سجّل سدادًا لمديونية سابقة.</div></div><button class="btn outline" onclick="loadCustomers()">↻ تحديث</button></div><div class="row"><input class="grow" value="${safeText(S.customerQuery||'')}" oninput="filterDebtCustomers(this.value)" placeholder="اسم العميل أو رقم الهاتف"><button class="btn green" onclick="S.showDebtCustomer=!S.showDebtCustomer;render()">➕ عميل</button></div><label class="sub" style="display:block;margin-top:10px"><input type="checkbox" ${debtOnly?'checked':''} onchange="S.debtOnly=this.checked;render()"> إظهار العملاء المديونين فقط</label>${newForm}${collection}</div><div class="card"><div class="report-head"><div class="title">العملاء (${customers.length})</div><span class="tag">إجمالي المتبقي ${money(customers.reduce((sum,c)=>sum+Math.max(0,num(c.balanceMinor)),0))}</span></div>${customers.length?customers.map(c=>`<div class="line"><div class="row between"><div><b>${safeText(c.name)}</b><div class="sub">${safeText(c.phone||'بدون هاتف')} • المتبقي <span class="debt-balance">${money(c.balanceMinor)}</span></div></div><button class="btn green" onclick="openCustomerCollection('${c.id}')">💰 سداد</button></div></div>`).join(''):`<div class="empty">لا توجد نتائج مطابقة. ألغِ فلتر المديونين أو أضف عميلًا.</div>`}</div>`);
  };
  filterDebtCustomers=function(value){S.customerQuery=value;render()};
  openCustomerCollection=function(id){const found=(S.customers||[]).find(c=>c.id===id);if(!found)return;S.collectingCustomer=found;S.showDebtCustomer=false;render()};
  saveDebtCustomer=async function(){
    const name=val('dcName').trim(), opening=Math.round(num(val('dcOpening'))*100), limit=Math.round(num(val('dcLimit'))*100);
    if(name.length<2)return flash('اكتب اسم العميل كاملًا','err');
    try{busy(true);await command('POST','/v1/partners/customers',{name,phone:val('dcPhone').trim()||undefined,openingBalanceMinor:Math.max(0,opening),creditLimitMinor:Math.max(0,limit)});S.showDebtCustomer=false;await loadCustomers(false);flash('تمت إضافة العميل وتسجيل المديونية الافتتاحية')}catch(error){flash(error.message,'err')}finally{busy(false)}
  };
  payCustomerDebt=async function(){
    const customer=S.collectingCustomer, amount=Math.round(num(val('dcPay'))*100);
    if(!customer||amount<=0)return flash('أدخل مبلغ سداد صحيحًا','err');
    try{busy(true);await command('POST','/v1/partners/customer/collect',{idempotencyKey:crypto.randomUUID(),payment:{partnerId:customer.id,amountMinor:amount,note:val('dcPayNote').trim()||'سداد من نبتة دكاني'}});S.collectingCustomer=null;await loadCustomers(false);flash('تم تسجيل السداد وتحديث الرصيد')}catch(error){flash(error.message,'err')}finally{busy(false)}
  };

  reportsView=function(){
    const report=S.fullReport;
    const dates=S.reportDates||{from:today(),to:today()};
    const summary=report?.summary;
    view(`<div class="card"><div class="title">📊 التقارير والأرباح</div><div class="sub">اعرض المبيعات والأرباح والمصروفات ثم صدّر ملف Excel من الهاتف.</div><div class="g2 grid" style="margin-top:9px"><div><label>من</label><input id="rf" type="date" value="${safeText(dates.from)}"></div><div><label>إلى</label><input id="rt" type="date" value="${safeText(dates.to)}"></div></div><div class="g2 grid" style="margin-top:9px"><button class="btn primary" onclick="loadReport()">🔎 عرض التقرير</button><button class="btn outline" ${report?'':'disabled'} onclick="exportPhoneReport()">📥 تصدير Excel</button></div></div>${!report?'<div class="empty">اختر الفترة ثم اضغط «عرض التقرير». ستظهر البيانات عند توفر صلاحية التقارير.</div>':`<div class="grid g2"><div class="metric"><small>صافي المبيعات</small><b>${money(summary.netSalesMinor)}</b></div><div class="metric"><small>صافي الربح التقديري</small><b>${money(summary.estimatedNetProfitMinor)}</b></div><div class="metric"><small>المصروفات والرواتب</small><b>${money(num(summary.expensesMinor)+num(summary.payrollMinor))}</b></div><div class="metric"><small>عدد الفواتير</small><b>${summary.invoiceCount||0}</b></div></div><div class="card"><div class="report-head"><div class="title">أفضل الأصناف</div><span class="tag">${safeText(report.period.from)} ← ${safeText(report.period.to)}</span></div>${report.topProducts?.length?`<table class="report-table"><thead><tr><th>الصنف</th><th>الكمية</th><th>المبيعات</th><th>الربح</th></tr></thead><tbody>${report.topProducts.map(item=>`<tr><td>${safeText(item.nameAr)}</td><td>${(num(item.netQtyMilli)/1000).toLocaleString('ar-EG')}</td><td>${shortMoney(item.netSalesMinor)}</td><td>${shortMoney(item.grossProfitMinor)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">لا توجد مبيعات في الفترة المختارة.</div>'}</div><div class="card"><div class="title">المخزون والتنبيهات</div><div class="sub">قيمة المخزون: ${money(report.inventory?.inventoryValueMinor)} • أصناف تحت الحد: ${report.inventory?.lowStockCount||0} • نفدت: ${report.inventory?.outOfStockCount||0}</div>${report.insights?.length?`<hr class="hr">${report.insights.map(x=>`<div class="sub">• ${safeText(x)}</div>`).join('')}`:''}</div>`}`);
  };
  loadReport=async function(){
    const from=val('rf'),to=val('rt');
    if(!from||!to||from>to)return flash('راجع تاريخ بداية ونهاية التقرير','err');
    try{busy(true);S.reportDates={from,to};S.fullReport=await command('GET',`/v1/reports/comprehensive?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);S.report=S.fullReport.summary;render()}catch(error){flash(error.message?.includes('FORBIDDEN')?'لا تملك صلاحية عرض التقارير. سجّل الدخول بحساب له صلاحية التقارير.':error.message,'err')}finally{busy(false)}
  };
  function workbookSheet(name,headers,rows){return `<Worksheet ss:Name="${escXml(name).slice(0,31)}"><Table>${`<Row>${headers.map(h=>`<Cell ss:StyleID="Header"><Data ss:Type="String">${escXml(h)}</Data></Cell>`).join('')}</Row>`}${rows.map(row=>`<Row>${row.map(value=>`<Cell><Data ss:Type="String">${escXml(value)}</Data></Cell>`).join('')}</Row>`).join('')}</Table></Worksheet>`}
  exportPhoneReport=async function(){
    const r=S.fullReport;if(!r)return;
    const s=r.summary;
    const summaryRows=[['الفترة',`${r.period.from} إلى ${r.period.to}`],['صافي المبيعات',shortMoney(s.netSalesMinor)],['صافي الربح التقديري',shortMoney(s.estimatedNetProfitMinor)],['إجمالي الخصومات',shortMoney(s.discountsMinor)],['المرتجعات',shortMoney(s.returnsMinor)],['المصروفات',shortMoney(s.expensesMinor)],['الرواتب',shortMoney(s.payrollMinor)],['عدد الفواتير',String(s.invoiceCount||0)]];
    const productRows=(r.topProducts||[]).map(x=>[x.nameAr,x.category,(num(x.netQtyMilli)/1000).toString(),shortMoney(x.netSalesMinor),shortMoney(x.grossProfitMinor)]);
    const dailyRows=(r.dailySales||[]).map(x=>[x.date,shortMoney(x.netSalesMinor),shortMoney(x.grossProfitMinor),String(x.invoiceCount)]);
    const xml=`<?xml version="1.0" encoding="UTF-8"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#DDF2E8" ss:Pattern="Solid"/></Style></Styles>${workbookSheet('ملخص التقرير',['البند','القيمة'],summaryRows)}${workbookSheet('أفضل الأصناف',['الصنف','التصنيف','الكمية','المبيعات','الربح'],productRows)}${workbookSheet('المبيعات اليومية',['التاريخ','المبيعات','الربح','الفواتير'],dailyRows)}</Workbook>`;
    try{busy(true);await native('exportSpreadsheet',`nabta-report-${r.period.from}-${r.period.to}.xls`,xml);flash('تم تصدير ملف Excel بنجاح')}catch(error){if(error.message!=='تم إلغاء تصدير التقرير')flash(error.message,'err')}finally{busy(false)}
  };

  searchSale=async function(){
    const q=val('sq').trim();if(!q)return;
    try{busy(true);const result=await native('search',q);S.products=(result.products||[]).sort((a,b)=>{const stockA=num(a.availableQtyMilli)>0?1:0,stockB=num(b.availableQtyMilli)>0?1:0;if(stockA!==stockB)return stockB-stockA;return String(a.nameAr||'').localeCompare(String(b.nameAr||''),'ar')});const box=document.getElementById('saleResults');box.innerHTML=S.products.length?S.products.map((p,index)=>{const ready=num(p.availableQtyMilli)>0;return `<div class="line sale-result ${ready?'':'out'}"><div class="row between"><div><b>${safeText(p.nameAr)}</b><div class="sub"><span class="availability ${ready?'':'empty'}">${ready?'✓ متوفر':'غير متوفر'}</span> المتاح ${(num(p.availableQtyMilli)/1000).toLocaleString('ar-EG')} • ${money(p.priceMinor)}</div></div><button class="btn ${ready?'green':'muted'}" ${ready?'':'disabled'} onclick="addSaleProduct(${index})">🛒 للسلة</button></div></div>`}).join(''):'<div class="empty">لا توجد منتجات مطابقة.</div>'}catch(error){flash(error.message,'err')}finally{busy(false)}
  };

  if(S.session)render();
})();
