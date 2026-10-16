/* Pure domain helpers. Integer piastres; quantities to three decimal places. */
(function(root){
  'use strict';
  const quantity=n=>Math.round(Number(n)*1000)/1000;
  const amount=(unitPrice,qty)=>Math.round(unitPrice*quantity(qty));
  function totals(lines,discount=0){
    const subtotal=lines.reduce((sum,line)=>sum+amount(line.price,line.qty),0);
    if(!Number.isInteger(discount)||discount<0||discount>subtotal) throw Error('الخصم يجب أن يكون بين صفر وقيمة الفاتورة');
    const cost=lines.reduce((sum,line)=>sum+amount(line.cost,line.qty),0);
    return {subtotal,discount,total:subtotal-discount,cost,grossProfit:subtotal-discount-cost};
  }
  function validateLines(products,lines){
    if(!lines.length) throw Error('أضف صنفًا إلى الفاتورة أولًا');
    const used=new Map();
    for(const line of lines){
      const p=products.find(x=>x.id===line.id);
      if(!p)throw Error('الصنف غير موجود');
      if(!Number.isFinite(line.qty)||line.qty<=0||quantity(line.qty)!==line.qty)throw Error('الكمية غير صحيحة');
      if(p.unit==='قطعة'&&!Number.isInteger(line.qty))throw Error('هذا الصنف يُباع بالقطعة');
      used.set(p.id,(used.get(p.id)||0)+line.qty);
      if(used.get(p.id)>p.stock)throw Error('المخزون غير كافٍ: '+p.name);
    }
  }
  function sale(state,lines,options){
    if(!state.shift.open)throw Error('افتح الوردية قبل البيع');
    validateLines(state.products,lines);
    // Prices/costs come from current catalog, never from editable cart input.
    const frozen=lines.map(line=>{const p=state.products.find(p=>p.id===line.id);return {id:p.id,name:p.name,unit:p.unit,qty:line.qty,price:p.price,cost:p.cost};});
    const t=totals(frozen,options.discount);
    if(options.method==='cash'&&(!Number.isInteger(options.received)||options.received<t.total))throw Error('المبلغ المدفوع أقل من المطلوب');
    if(!['cash','card'].includes(options.method))throw Error('طريقة الدفع غير صالحة');
    const next=JSON.parse(JSON.stringify(state));
    frozen.forEach(l=>{const p=next.products.find(p=>p.id===l.id);p.stock=quantity(p.stock-l.qty);});
    const invoice={id:options.id,at:options.at,shiftId:state.shift.id,lines:frozen,...t,method:options.method,received:options.method==='cash'?options.received:t.total,returned:false};
    next.sales.push(invoice);
    next.audit.unshift({at:options.at,event:'بيع',detail:options.id+' • '+frozen.length+' أصناف'});
    return {state:next,invoice,change:invoice.received-t.total};
  }
  function refund(state,id,at){
    const invoice=state.sales.find(x=>x.id===id);
    if(!invoice||invoice.returned)throw Error('الفاتورة غير موجودة أو مرتجعة بالفعل');
    if(!state.shift.open)throw Error('افتح الوردية قبل المرتجع');
    const next=JSON.parse(JSON.stringify(state));
    const sale=next.sales.find(x=>x.id===id);
    sale.returned=true;sale.returnedAt=at;sale.returnShiftId=state.shift.id;
    sale.lines.forEach(l=>{const p=next.products.find(x=>x.id===l.id);if(p)p.stock=quantity(p.stock+l.qty);});
    next.audit.unshift({at,event:'مرتجع كامل',detail:id});
    return next;
  }
  function summary(state){
    const active=state.sales.filter(s=>!s.returned);
    const revenue=active.reduce((a,s)=>a+s.total,0),cogs=active.reduce((a,s)=>a+s.cost,0);
    const expenses=state.expenses.reduce((a,e)=>a+e.amount,0);
    return {revenue,cogs,expenses,grossProfit:revenue-cogs,netProfit:revenue-cogs-expenses,count:active.length};
  }
  function expectedCash(state){
    const cash=state.sales.filter(s=>s.shiftId===state.shift.id&&s.method==='cash').reduce((a,s)=>a+s.total,0);
    const returns=state.sales.filter(s=>s.returnShiftId===state.shift.id&&s.method==='cash').reduce((a,s)=>a+s.total,0);
    const expenses=state.expenses.filter(e=>e.shiftId===state.shift.id).reduce((a,e)=>a+e.amount,0);
    return state.shift.opening+cash-returns-expenses;
  }
  const api={quantity,amount,totals,validateLines,sale,refund,summary,expectedCash};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.POS=api;
})(typeof window!=='undefined'?window:globalThis);
