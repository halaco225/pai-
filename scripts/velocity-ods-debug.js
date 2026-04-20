'use strict';
var fs   = require('fs');
var path = require('path');
var ODS_URL  = 'https://bi.onedatasource.com';
var ODS_ORG  = process.env.ODS_ORG  || 'dgi';
var ODS_USER = process.env.ODS_USER || 'hlacoste';
var ODS_PASS = process.env.ODS_PASSWORD || '';
function fetch() { return require('node-fetch').apply(null, arguments); }
function parseCookies(r) {
  return (r.headers.raw()['set-cookie']||[]).map(function(c){return c.split(';')[0];});
}
function mergeCookies(a,b,c) {
  var map=new Map();
  [].concat(a||[],b||[],c||[]).forEach(function(ck){var n=ck.split('=')[0];map.set(n,ck);});
  return Array.from(map.values()).join('; ');
}
async function login() {
  var UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  var r1=await fetch(ODS_URL+'/asp/login.html',{headers:{'User-Agent':UA}});
  var c1=parseCookies(r1);
  var r2=await fetch(ODS_URL+'/asp/JavaScriptServlet',{method:'POST',
    headers:{'Cookie':mergeCookies(c1),'FETCH-CSRF-TOKEN':'1','X-Requested-With':'XMLHttpRequest','User-Agent':UA}});
  var c2=parseCookies(r2); var raw=await r2.text(); var colon=raw.indexOf(':');
  var cn=raw.substring(0,colon).trim(); var cv=raw.substring(colon+1).trim();
  var fb=['orgId='+encodeURIComponent(ODS_ORG),'j_username='+encodeURIComponent(ODS_USER),
    'j_password='+encodeURIComponent(ODS_PASS),'j_password_pseudo='+encodeURIComponent(ODS_PASS),
    cn+'='+encodeURIComponent(cv)].join('&');
  var r3=await fetch(ODS_URL+'/asp/j_spring_security_check',{method:'POST',redirect:'manual',
    headers:{'Content-Type':'application/x-www-form-urlencoded','Cookie':mergeCookies(c1,c2),
             'Referer':ODS_URL+'/asp/login.html','Origin':ODS_URL,'User-Agent':UA},body:fb});
  var c3=parseCookies(r3); var loc=r3.headers.get('location')||'';
  if(loc.indexOf('error')>=0) throw new Error('Login failed: '+loc);
  return {cookie:mergeCookies(c1,c2,c3),ua:UA};
}
async function getFreshCsrf(cookie,ua) {
  var r=await fetch(ODS_URL+'/asp/JavaScriptServlet',{method:'POST',
    headers:{'Cookie':cookie,'FETCH-CSRF-TOKEN':'1','User-Agent':ua}});
  var t=await r.text(); var colon=t.indexOf(':');
  return {name:t.substring(0,colon).trim(), value:t.substring(colon+1).trim()};
}

async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess=await login(); var cookie=sess.cookie; var ua=sess.ua;
  var UA = ua;
  var findings = {};

  // =====================================================================
  // A. Full store list from REST API
  // =====================================================================
  console.log('\n--- A. Store list ---');
  var storeRes = await fetch(ODS_URL+'/asp/rest_v2/aboveStore/stores?storeAccess=true',
    {headers:{Cookie:cookie,'User-Agent':ua}});
  var storeJson = await storeRes.json();
  var stores = storeJson.item || [];
  console.log('Total stores:', stores.length);
  stores.slice(0,10).forEach(function(s){
    console.log('  storeId='+s.storeId+' storeNumber="'+s.storeNumber+'" storeName="'+s.storeName+'"');
  });
  findings.stores = stores;

  // orgType with various params
  var orgVariants = [
    '/asp/rest_v2/aboveStore/orgType',
    '/asp/rest_v2/aboveStore/orgType?orgId=dgi',
    '/asp/rest_v2/aboveStore/orgType?org=dgi',
    '/asp/rest_v2/aboveStore/orgType?brandId=PHD',
    '/asp/rest_v2/aboveStore/orgType?brand=PH',
    '/asp/rest_v2/aboveStore/reportTypes',
    '/asp/rest_v2/aboveStore/reports',
    '/asp/rest_v2/aboveStore/dates',
    '/asp/rest_v2/aboveStore/available',
  ];
  console.log('\n--- A2. orgType variants ---');
  for (var i=0; i<orgVariants.length; i++) {
    var ov = orgVariants[i];
    var ovr = await fetch(ODS_URL+ov, {headers:{Cookie:cookie,'User-Agent':ua}});
    var ovt = await ovr.text();
    console.log('  '+ov.replace('/asp/rest_v2/aboveStore','').padEnd(30)+' -> '+ovr.status+' '+ovt.substring(0,120));
  }

  // =====================================================================
  // B. Parse s1 HTML for ALL form structure
  // =====================================================================
  console.log('\n--- B. s1 HTML form structure ---');
  var csrf = await getFreshCsrf(cookie, ua);
  var flowRes = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow',
    {headers:{Cookie:cookie,'User-Agent':ua}});
  var s1html = await flowRes.text();
  var s1lines = s1html.split('\n');

  // Extract flowExecutionKey
  var km = s1html.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  var s1Key = km ? km[1] : null;
  console.log('s1Key:', s1Key);

  // Print all lines with form-related keywords
  var formKeywords = ['<form', '</form', '<input', '<button', '<select', '_eventId',
    'onclick', 'submit', 'name=', 'action=', 'data-event', 'href.*flow'];
  console.log('\nForm-related lines:');
  s1lines.forEach(function(line, idx) {
    var lc = line.toLowerCase();
    var relevant = formKeywords.some(function(kw){ return lc.indexOf(kw.toLowerCase())>=0; });
    if (relevant) {
      console.log('  L'+(idx+1)+': '+line.trim().substring(0,200));
    }
  });

  // Also print lines 1-30 (head/meta) to see page structure
  console.log('\nFirst 20 lines of s1:');
  s1lines.slice(0,20).forEach(function(l,i){ console.log('  L'+(i+1)+': '+l.substring(0,150)); });

  // Print lines containing 'date' or 'store' or 'report'
  console.log('\nLines with date/store/report keywords:');
  s1lines.forEach(function(line, idx) {
    var lc = line.toLowerCase();
    if ((lc.indexOf('date')>=0 || lc.indexOf('store')>=0 || lc.indexOf('report')>=0) && line.trim().length > 5) {
      console.log('  L'+(idx+1)+': '+line.trim().substring(0,200));
    }
  });
  findings.s1Key = s1Key;
  findings.s1Length = s1html.length;

  // =====================================================================
  // C. commons.main.js - search for aboveStore/flow patterns
  // =====================================================================
  console.log('\n--- C. commons.main.js pattern search ---');
  // Try multiple possible paths
  var cmPaths = [
    '/asp/optimized-scripts/commons/dist/commons.main.js',
    '/asp/optimized-scripts/commons.main.js',
  ];
  var cmText = null;
  for (var cp=0; cp<cmPaths.length; cp++) {
    var cmRes = await fetch(ODS_URL+cmPaths[cp], {headers:{Cookie:cookie,'User-Agent':ua}});
    if (cmRes.ok) {
      cmText = await cmRes.text();
      console.log('Fetched from:', cmPaths[cp], 'size:', cmText.length);
      break;
    }
  }
  if (cmText) {
    var searchTerms = [
      'getReportsForView', 'aboveStore', 'InStoreTime', 'inStoreTime',
      'exportType', 'contentDisposition', '_eventId', 'flowExecutionKey',
      'brandId', 'storeId', 'reportDate', 'startDate', 'endDate',
      'aboveStoreInStoreReports', 'rest_v2/aboveStore'
    ];
    searchTerms.forEach(function(term) {
      var idx = 0;
      var count = 0;
      var snippets = [];
      while ((idx = cmText.indexOf(term, idx)) >= 0 && snippets.length < 3) {
        var start = Math.max(0, idx-60);
        var end = Math.min(cmText.length, idx+term.length+100);
        snippets.push(cmText.substring(start, end).replace(/\n/g,' '));
        idx += term.length;
        count++;
      }
      if (count > 0) {
        console.log('\n  ['+term+'] found '+count+'x:');
        snippets.forEach(function(s){ console.log('    ...'+s+'...'); });
      }
    });
    findings.commonsMainSize = cmText.length;
  } else {
    console.log('commons.main.js not found');
  }

  // =====================================================================
  // D. Step-by-step flow navigation with actual store ID
  // =====================================================================
  console.log('\n--- D. Step-by-step navigation ---');
  if (!s1Key) { console.log('No s1Key, skipping'); }
  else {
    var storeId = stores.length > 0 ? stores[0].storeId : 29865;
    var dateStr = '2026-04-18';
    var dateFmt2 = '04/18/2026'; // MM/DD/YYYY
    
    // Events to try one at a time, using new key from each response
    var stepEvents = [
      {name:'view', params:''},
      {name:'start', params:''},
      {name:'initialize', params:''},
      {name:'selectStores', params:'selectedStores='+storeId},
      {name:'selectDate', params:'reportDate='+dateStr},
      {name:'submitForm', params:'stores='+storeId+'&reportDate='+dateStr+'&brandId=PHD'},
      {name:'submit', params:'stores='+storeId+'&reportDate='+dateStr},
    ];

    var currentKey = s1Key;
    for (var si=0; si<stepEvents.length; si++) {
      var step = stepEvents[si];
      csrf = await getFreshCsrf(cookie, ua);
      var hdrs = {Cookie:cookie,'User-Agent':ua,
        'Content-Type':'application/x-www-form-urlencoded',
        'X-Requested-With':'OWASP CSRFGuard Project',
        'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
      hdrs[csrf.name] = csrf.value;
      var body = '_flowExecutionKey='+encodeURIComponent(currentKey)
        +'&_eventId='+step.name
        +(step.params ? '&'+step.params : '')
        +'&'+csrf.name+'='+encodeURIComponent(csrf.value);
      var pr = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow',
        {method:'POST',headers:hdrs,body:body});
      var pct = pr.headers.get('content-type')||'';
      var ptxt = await pr.text();
      var newKey = (ptxt.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/))||[];
      newKey = newKey[1] || null;
      var title = (ptxt.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
      var isLogin = ptxt.indexOf('oneVIEW: Login')>=0;
      var isPdf = pct.indexOf('pdf')>=0 || pct.indexOf('octet')>=0;
      console.log('  POST '+step.name.padEnd(20)+' key='+currentKey+' -> '+pr.status
        +' title="'+title+'" newKey='+newKey+' pdf='+isPdf+' login='+isLogin);
      if (isPdf) {
        fs.writeFileSync('/opt/render/project/src/uploads/hit.pdf', Buffer.from(ptxt));
        console.log('  *** PDF SAVED ***');
        return;
      }
      // Print form elements from response
      if (!isLogin && newKey) {
        var respLines = ptxt.split('\n');
        var formLines = [];
        respLines.forEach(function(line) {
          var lc = line.toLowerCase();
          if (lc.indexOf('<input')>=0 || lc.indexOf('<button')>=0 || lc.indexOf('_eventid')>=0 || lc.indexOf('onclick')>=0) {
            formLines.push(line.trim().substring(0,200));
          }
        });
        if (formLines.length) {
          console.log('    Form elements in response:');
          formLines.slice(0,10).forEach(function(l){ console.log('      '+l); });
        }
        currentKey = newKey;
      }
    }
  }

  // =====================================================================
  // E. Try GET navigation (like browser clicking links/buttons)
  // =====================================================================
  console.log('\n--- E. GET navigation chain ---');
  var csrf5 = await getFreshCsrf(cookie, ua);
  var getHdrs = {Cookie:cookie,'User-Agent':ua,
    'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  getHdrs[csrf5.name] = csrf5.value;

  var getChain = ['view','start','next','selectInStoreTime','inStoreTime','viewInStoreTime'];
  var gKey = s1Key;
  for (var gi=0; gi<getChain.length; gi++) {
    var gev = getChain[gi];
    var gurl = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'
      +'&_flowExecutionKey='+encodeURIComponent(gKey)+'&_eventId='+gev;
    var gr = await fetch(gurl, {headers:getHdrs});
    var gct = gr.headers.get('content-type')||'';
    var gtxt = await gr.text();
    var gnk = (gtxt.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/))||[];
    gnk = gnk[1] || null;
    var gt = (gtxt.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
    var isPdf = gct.indexOf('pdf')>=0 || gct.indexOf('octet')>=0;
    console.log('  GET '+gev.padEnd(25)+' key='+gKey+' -> '+gr.status+' "'+gt+'" newKey='+gnk+' pdf='+isPdf);
    if (isPdf) {
      fs.writeFileSync('/opt/render/project/src/uploads/hit.pdf', Buffer.from(gtxt));
      console.log('  *** PDF SAVED ***');
      return;
    }
    if (gnk && gnk !== gKey) {
      // New key -- try getReportsForView immediately
      csrf5 = await getFreshCsrf(cookie, ua);
      getHdrs[csrf5.name] = csrf5.value;
      var pdfUrl = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'
        +'&_flowExecutionKey='+encodeURIComponent(gnk)
        +'&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment';
      var pdfR = await fetch(pdfUrl, {headers:getHdrs});
      var pdfCt = pdfR.headers.get('content-type')||'';
      var pdfTxt = await pdfR.text();
      var pdfTitle = (pdfTxt.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
      console.log('    -> getReportsForView: '+pdfR.status+' ct='+pdfCt+' title="'+pdfTitle+'"');
      if (pdfCt.indexOf('pdf')>=0 || pdfCt.indexOf('octet')>=0) {
        fs.writeFileSync('/opt/render/project/src/uploads/hit.pdf', Buffer.from(pdfTxt));
        console.log('    *** PDF SAVED ***');
        return;
      }
    }
    if (gnk) gKey = gnk;
  }

  // Save findings
  try {
    var outPath = path.join(__dirname,'..','uploads','debug-findings.json');
    fs.mkdirSync(path.dirname(outPath),{recursive:true});
    fs.writeFileSync(outPath, JSON.stringify(findings,null,2));
    console.log('\nSaved to', outPath);
  } catch(e){ console.log('Save failed:', e.message); }
  console.log('\nDone.');
}

main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
