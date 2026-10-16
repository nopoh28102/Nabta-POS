// Optional: npm install --no-save playwright && npx playwright install chromium.
// Run node tests/browser-smoke.cjs. Starts a local preview server if needed.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
let previewServer;
(async()=>{
 try{await fetch('http://127.0.0.1:4173');}catch{
  const server=require('node:child_process').spawn(process.execPath,[path.join(__dirname,'../dev-server.cjs')],{stdio:['ignore','pipe','inherit']});
  previewServer=server;
  process.on('exit',()=>server.kill());
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(Error('Preview server exited '+code)));});
 }
 const browser=await chromium.launch({headless:true,executablePath:process.env.NABTA_CHROMIUM_PATH||chromium.executablePath(),args:process.env.NABTA_CHROMIUM_PATH?['--no-sandbox','--disable-dev-shm-usage']:[]});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:4173');
 await page.evaluate(()=>localStorage.clear());await page.reload();
 assert.equal(await page.locator('.product-card').count(),12);
 const stockBefore=await page.locator('[data-add=p1] .stock-badge').textContent();
 await page.locator('#pos-search').fill('6221000000011');await page.locator('#pos-search').press('Enter');
 assert.equal(await page.locator('.cart-line').count(),1);
 await page.locator('[data-add=p4]').click();await page.locator('#modal input[name=qty]').fill('0.375');await page.locator('#modal button[type=submit]').click();
 assert.equal(await page.locator('.cart-line').count(),2);
 await page.locator('#discount').fill('10');await page.locator('#discount').press('Tab');
 await page.locator('[data-action=hold]').click();assert.equal(await page.locator('.cart-line').count(),0);
 await page.locator('[data-action=held]').click();await page.locator('[data-resume]').click();assert.equal(await page.locator('.cart-line').count(),2);
 await page.locator('[data-action=pay]').click();await page.locator('#modal input[name=received]').fill('100');await page.locator('#modal button[type=submit]').click();
 await page.locator('.receipt').waitFor();
 let saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nabta-pos-demo-v1')));
 const invoice=saved.sales.at(-1);assert.equal(invoice.total,9800);assert.equal(invoice.received,10000);assert.equal(invoice.cost,8488);assert.equal(saved.held.length,0);
 const invoiceId=invoice.id;await page.locator('[data-action=close-modal]').first().click();
 await page.locator('[data-page=reports]').click();await page.locator(`[data-refund="${invoiceId}"]`).click();await page.locator('#modal button[type=submit]').click();
 saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nabta-pos-demo-v1')));assert.equal(saved.sales.at(-1).returned,true);
 await page.locator('[data-page=pos]').click();assert.equal(await page.locator('[data-add=p1] .stock-badge').textContent(),stockBefore);
 await page.locator('[data-page=products]').click();await page.locator('[data-action=add-product]').click();
 await page.locator('#modal input[name=name]').fill('صنف اختبار');await page.locator('#modal input[name=barcode]').fill('TEST-001');await page.locator('#modal input[name=price]').fill('25');await page.locator('#modal input[name=cost]').fill('18');await page.locator('#modal input[name=stock]').fill('3');await page.locator('#modal button[type=submit]').click();
 saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nabta-pos-demo-v1')));assert.equal(saved.products.length,13);
 await page.locator('[data-page=purchases]').click();await page.locator('[data-action=purchase]').click();await page.locator('#modal select[name=product]').selectOption(saved.products.at(-1).id);await page.locator('#modal input[name=qty]').fill('2');await page.locator('#modal input[name=cost]').fill('19');await page.locator('#modal button[type=submit]').click();
 saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nabta-pos-demo-v1')));assert.equal(saved.products.at(-1).stock,5);assert.equal(saved.purchases.length,1);
 await page.locator('[data-page=inventory]').click();await page.locator(`[data-adjust="${saved.products.at(-1).id}"]`).click();await page.locator('#modal input[name=actual]').fill('4');await page.locator('#modal input[name=reason]').fill('فرق عد تجريبي');await page.locator('#modal button[type=submit]').click();
 saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nabta-pos-demo-v1')));assert.equal(saved.products.at(-1).stock,4);
 await page.locator('[data-page=reports]').click();await page.locator('[data-action=expense]').click();await page.locator('#modal input[name=name]').fill('نقل');await page.locator('#modal input[name=amount]').fill('15');await page.locator('#modal button[type=submit]').click();
 await page.locator('[data-page=shift]').click();await page.locator('[data-action=close-shift]').click();await page.locator('#modal button[type=submit]').click();
 saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nabta-pos-demo-v1')));assert.equal(saved.shift.open,false);assert.equal(saved.shiftHistory.length,1);assert.equal(saved.shiftHistory[0].difference,0);
 await page.locator('[data-action=open-shift]').click();await page.locator('#modal input[name=opening]').fill('100');await page.locator('#modal button[type=submit]').click();
 saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nabta-pos-demo-v1')));assert.equal(saved.shift.open,true);
 // Backup then restore through actual file chooser and validation.
 await page.locator('[data-page=settings]').click();
 const downloadPromise=page.waitForEvent('download');await page.locator('[data-action=backup]').click();const backup=await downloadPromise;
 const backupPath=path.join('/tmp','nabta-ui-backup.json');await backup.saveAs(backupPath);
 const chooserPromise=page.waitForEvent('filechooser');await page.locator('[data-action=restore]').click();const chooser=await chooserPromise;await chooser.setFiles(backupPath);await page.locator('#modal button[type=submit]').click();
 await page.reload();saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nabta-pos-demo-v1')));assert.equal(saved.products.at(-1).stock,4);
 // Reset before screenshot so shipped previews show only the intended sample catalog.
 await page.locator('[data-page=settings]').click();await page.locator('[data-action=reset]').click();await page.locator('#modal button[type=submit]').click();
 const out=path.join(__dirname,'../docs/previews');fs.mkdirSync(out,{recursive:true});
 for(const [width,height]of [[1366,768],[1920,1080],[390,844]]){
  await page.setViewportSize({width,height});
  for(const id of ['dashboard','pos','products','inventory','purchases','contacts','reports','shift','settings']){
   await page.locator(`[data-page=${id}]`).click();
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
   assert.equal(overflow,false,`page overflow ${id} ${width}`);
   if(id==='pos'&&width!==1920||id==='dashboard'&&width===1366){
    await page.evaluate(()=>document.getElementById('toast').className='');
    if(id==='pos')for(const p of ['p1','p2','p9'])await page.locator(`[data-add=${p}]`).click();
    await page.screenshot({path:path.join(out,`${id}-${width}.png`),fullPage:true});
    if(id==='pos'){await page.locator('[data-action=clear]').click();await page.locator('#modal button[type=submit]').click();}
   }
  }
 }
 // Check double-click file entry as requested.
 const local=await browser.newPage();await local.goto('file://'+path.join(__dirname,'../frontend/index.html'));assert.equal(await local.locator('.product-card').count(),12);await local.close();
 assert.deepEqual(errors,[]);
 console.log('PASS: UI sale/weighted item/discount/hold/payment/refund/catalog/purchase/count/expense/shift/backup/restore/reload/file entry; 27 viewport-page checks; no page errors.');
 await browser.close();
 previewServer?.kill();
})().catch(e=>{console.error(e);process.exit(1)});
