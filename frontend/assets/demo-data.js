(function(){
  const now=new Date();const at=hours=>new Date(now.getTime()-hours*3600000).toISOString();
  window.createDemoState=()=>({
    version:1,store:{name:'ماركت نبتة',branch:'الفرع الرئيسي',address:'القاهرة',phone:'',receiptNote:'شكرًا لزيارتكم 🌿'},
    products:[
      {id:'p1',name:'حليب كامل الدسم',brand:'المراعي • ١ لتر',barcode:'6221000000011',category:'ألبان وأجبان',unit:'قطعة',price:4800,cost:3800,stock:48,min:10,expiry:'2026-10-22',art:'milk',color:'#87bce0'},
      {id:'p2',name:'زيت دوار الشمس',brand:'عافية • ٨٠٠ مل',barcode:'6221000000028',category:'مواد غذائية',unit:'قطعة',price:9200,cost:7600,stock:24,min:8,expiry:'2027-08-01',art:'oil',color:'#e8bf54'},
      {id:'p3',name:'أرز أبيض مصري',brand:'الضحى • ١ كجم',barcode:'6221000000035',category:'مواد غذائية',unit:'قطعة',price:3500,cost:2700,stock:65,min:15,expiry:'2027-06-01',art:'bag',color:'#82bca2'},
      {id:'p4',name:'جبنة بيضاء',brand:'طازجة • بالكيلو',barcode:'6221000000042',category:'ألبان وأجبان',unit:'كجم',price:16000,cost:12500,stock:12.5,min:3,expiry:'2026-10-17',art:'cheese',color:'#f0d9a4'},
      {id:'p5',name:'قهوة سريعة التحضير',brand:'نسكافيه • ١٠٠ جم',barcode:'6221000000059',category:'مشروبات',unit:'قطعة',price:14500,cost:11600,stock:8,min:10,expiry:'2027-10-01',art:'jar',color:'#b77f62'},
      {id:'p6',name:'عصير مانجو',brand:'جهينة • ١ لتر',barcode:'6221000000066',category:'مشروبات',unit:'قطعة',price:3800,cost:2800,stock:36,min:8,expiry:'2026-12-01',art:'milk',color:'#edb965'},
      {id:'p7',name:'مكرونة أقلام',brand:'الملكة • ٤٠٠ جم',barcode:'6221000000073',category:'مواد غذائية',unit:'قطعة',price:1800,cost:1400,stock:80,min:20,expiry:'2027-05-01',art:'bag',color:'#cc8378'},
      {id:'p8',name:'عطر مسك أبيض',brand:'روائح • ٥٠ مل',barcode:'6221000000080',category:'عناية وعطور',unit:'قطعة',price:18500,cost:11500,stock:6,min:4,expiry:'2028-01-01',art:'perfume',color:'#b8a7ce'},
      {id:'p9',name:'بسكويت بالشوكولاتة',brand:'مولتو • عبوة',barcode:'6221000000097',category:'حلويات',unit:'قطعة',price:1500,cost:1050,stock:54,min:12,expiry:'2027-02-01',art:'bag',color:'#aa8972'},
      {id:'p10',name:'منظف أرضيات',brand:'داوني • ١ لتر',barcode:'6221000000103',category:'منظفات',unit:'قطعة',price:6500,cost:4700,stock:7,min:8,expiry:'2028-01-01',art:'oil',color:'#a4a5d9'},
      {id:'p11',name:'مياه معدنية',brand:'نستله • ١٫٥ لتر',barcode:'6221000000110',category:'مشروبات',unit:'قطعة',price:1000,cost:700,stock:96,min:24,expiry:'2027-05-01',art:'water',color:'#93c8d2'},
      {id:'p12',name:'زبادي طبيعي',brand:'جهينة • ١٠٥ جم',barcode:'6221000000127',category:'ألبان وأجبان',unit:'قطعة',price:900,cost:650,stock:3,min:12,expiry:'2026-10-12',art:'cup',color:'#78aeb5'},
    ],
    sales:[],purchases:[],expenses:[],held:[],
    contacts:[{id:'c1',name:'شركة الألبان الحديثة',type:'مورد',phone:'01000000001'},{id:'c2',name:'أحمد محمد',type:'عميل',phone:'01000000002'}],
    shift:{id:'SHIFT-DEMO-1',open:true,opening:50000,startedAt:at(2),cashier:'محمود نبيه',till:'كاشير ١'},shiftHistory:[],
    audit:[{at:at(2),event:'فتح وردية',detail:'رصيد افتتاحي ٥٠٠ ج.م • بيانات تجريبية'}]
  });
})();
