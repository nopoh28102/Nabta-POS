const {test}=require('node:test'),assert=require('node:assert/strict');
const E=require('../frontend/assets/engine.js');
function base(){return {products:[{id:'p',name:'Milk',unit:'قطعة',price:4800,cost:3800,stock:5},{id:'w',name:'Cheese',unit:'كجم',price:16000,cost:12500,stock:2}],sales:[],expenses:[],audit:[],shift:{open:true,id:'s1',opening:50000}};}
function sell(s=base(),lines=[{id:'p',qty:2}],options={}){return E.sale(s,lines,{discount:1000,received:10000,method:'cash',id:'inv1',at:'2026-10-09T12:00:00Z',...options});}
test('discount, cost, gross profit and cash change in piastres',()=>{const r=sell();assert.equal(r.invoice.total,8600);assert.equal(r.invoice.cost,7600);assert.equal(r.invoice.grossProfit,1000);assert.equal(r.change,1400);assert.equal(r.state.products[0].stock,3);});
test('sale creates a new state without mutating original',()=>{const s=base();sell(s);assert.equal(s.products[0].stock,5);assert.equal(s.sales.length,0);});
test('prices from catalog override stale or tampered cart values',()=>{const r=sell(base(),[{id:'p',qty:2,price:1,cost:0}]);assert.equal(r.invoice.subtotal,9600);assert.equal(r.invoice.cost,7600);});
test('duplicate lines cannot collectively oversell',()=>assert.throws(()=>sell(base(),[{id:'p',qty:3},{id:'p',qty:3}]),/المخزون/));
test('oversell rejects without changing data',()=>{const s=base();assert.throws(()=>sell(s,[{id:'p',qty:6}]),/المخزون/);assert.equal(s.sales.length,0);});
test('weighted quantities use precision of 0.001 kg',()=>{const r=sell(base(),[{id:'w',qty:.375}],{discount:0,received:6000});assert.equal(r.invoice.total,6000);assert.equal(r.invoice.cost,4688);assert.equal(r.state.products[1].stock,1.625);});
test('unit products cannot use fractions',()=>assert.throws(()=>sell(base(),[{id:'p',qty:.5}]),/بالقطعة/));
test('empty and negative quantities reject',()=>{assert.throws(()=>sell(base(),[]));assert.throws(()=>sell(base(),[{id:'p',qty:-1}]));});
test('closed shift rejects sale',()=>{const s=base();s.shift.open=false;assert.throws(()=>sell(s),/الوردية/);});
test('excessive or negative discounts reject',()=>{assert.throws(()=>sell(base(),undefined,{discount:10000}));assert.throws(()=>sell(base(),undefined,{discount:-1}));});
test('insufficient tender and invalid method reject',()=>{assert.throws(()=>sell(base(),undefined,{received:10}),/المدفوع/);assert.throws(()=>sell(base(),undefined,{method:'unknown'}));});
test('card sale ignores cash tender and cash drawer',()=>{const r=sell(base(),undefined,{method:'card',received:0});assert.equal(r.invoice.received,8600);assert.equal(E.expectedCash(r.state),50000);});
test('full refund restores stock and profit once',()=>{const s=sell().state,r=E.refund(s,'inv1','2026-10-09T13:00:00Z');assert.equal(r.products[0].stock,5);assert.equal(E.summary(r).revenue,0);assert.equal(E.expectedCash(r),50000);assert.throws(()=>E.refund(r,'inv1','2026-10-09T14:00:00Z'));});
test('refund in a later shift withdraws from current drawer',()=>{const s=sell().state;s.shift={open:true,id:'s2',opening:20000};const r=E.refund(s,'inv1','2026-10-10T13:00:00Z');assert.equal(E.expectedCash(r),11400);});
test('cash expense reduces expected cash and net profit',()=>{const s=sell().state;s.expenses.push({amount:500,shiftId:'s1'});assert.equal(E.expectedCash(s),58100);assert.equal(E.summary(s).netProfit,500);});
