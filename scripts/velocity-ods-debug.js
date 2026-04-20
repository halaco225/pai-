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

  // =====================================================================
  // A. Full require.config.js -- all aboveStore entries + all paths
  // =====================================================================
  console.log('\n--- A. require.config.js full aboveStore entries ---');
  var rcRes = await fetch(ODS_URL+'/asp/optimized-scripts/require.config.js',
    {headers:{Cookie:cookie,'User-Agent':ua}});
  var rcText = await rcRes.text();
  var rcLines = rcText.split('\n');
  var abLines = rcLines.filter(function(l){ return /aboveStore/i.test(l); });
  console.log('aboveStore lines ('+abLines.length+'):');
  abLines.forEach(function(l){ console.log('  '+l.trim()); });

  // Fetch ALL aboveStore dist files referenced
  console.log('\nFetching all aboveStore dist files...');
  var distPaths = [];
  abLines.forEach(function(l){
    var m = l.match(/"([^"]*aboveStore[^"]*)"/gi);
    if (m) m.forEach(function(p){ distPaths.push(p.replace(/"/g,'')); });
  });
  var uniquePaths = distPaths.filter(function(v,i,a){ return a.indexOf(v)===i; });
  for (var i=0; i<uniquePaths.length; i++) {
    var dp = uniquePaths[i];
    var url = ODS_URL+'/asp/optimized-scripts/'+dp+'.js';
    var dr = await fetch(url, {headers:{Cookie:cookie,'User-Agent':ua}});
    var dt = await dr.text();
    if (dr.ok) {
      console.log('\n  ['+dp+'] '+dt.length+' bytes:');
      // Search for key terms
      ['getReportsForView','eventId','flowExecutionKey','categoryId','storeId','date','export','pdf'].forEach(function(term){
        var idx = dt.indexOf(term);
        if (idx>=0) {
          var ctx = dt.substring(Math.max(0,idx-80), Math.min(dt.length,idx+100));
          console.log('    FOUND "'+term+'": ...'+ctx.replace(/\n/g,' ')+'...');
        }
      });
      if (dt.length < 3000) console.log('  Full content: '+dt.trim());
    }
  }

  // =====================================================================
  // B. commons.main.js -- deep search for categoryId + IST patterns
  // =====================================================================
  console.log('\n--- B. commons.main.js deep search ---');
  var cmRes = await fetch(ODS_URL+'/asp/optimized-scripts/commons.main.js',
    {headers:{Cookie:cookie,'User-Agent':ua}});
  var cmText = await cmRes.text();

  // Find ALL categoryId references
  console.log('\ncategoryId occurrences:');
  var idx=0; var count=0;
  while((idx=cmText.indexOf('categoryId',idx))>=0 && count<20) {
    var ctx = cmText.substring(Math.max(0,idx-100),Math.min(cmText.length,idx+150));
    console.log('  ['+count+'] ...'+ctx.replace(/\n/g,' ')+'...');
    idx+=10; count++;
  }

  // Find aboveStoreInStore* entries with full context
  console.log('\naboveStoreInStore* full context:');
  idx=0; count=0;
  while((idx=cmText.indexOf('aboveStoreInStore',idx))>=0 && count<10) {
    var ctx = cmText.substring(Math.max(0,idx-20),Math.min(cmText.length,idx+200));
    console.log('  ...'+ctx.replace(/\n/g,' ')+'...');
    idx+=20; count++;
  }

  // Find getReportsForView
  console.log('\ngetReportsForView occurrences:');
  idx=0; count=0;
  while((idx=cmText.indexOf('getReportsForView',idx))>=0 && count<5) {
    var ctx = cmText.substring(Math.max(0,idx-150),Math.min(cmText.length,idx+200));
    console.log('  ...'+ctx.replace(/\n/g,' ')+'...');
    idx+=20; count++;
  }

  // Find exportType
  console.log('\nexportType occurrences:');
  idx=0; count=0;
  while((idx=cmText.indexOf('exportType',idx))>=0 && count<5) {
    var ctx = cmText.substring(Math.max(0,idx-100),Math.min(cmText.length,idx+150));
    console.log('  ...'+ctx.replace(/\n/g,' ')+'...');
    idx+=12; count++;
  }

  // =====================================================================
  // C. Try flow init WITH categoryId=1 through 8
  //    Immediately try getReportsForView + export params
  // =====================================================================
  console.log('\n--- C. Flow init with categoryId ---');
  var storeId = 29865;
  var dateStr = '2026-04-18';

  for (var cat=1; cat<=8; cat++) {
    var csrf = await getFreshCsrf(cookie, ua);
    var hdrs = {Cookie:cookie,'User-Agent':ua,
      'X-Requested-With':'OWASP CSRFGuard Project',
      'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
    hdrs[csrf.name] = csrf.value;

    // Init with categoryId
    var initUrl = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&categoryId='+cat;
    var ir = await fetch(initUrl, {headers:hdrs});
    var ict = ir.headers.get('content-type')||'';
    var ihtml = await ir.text();
    var ikm = ihtml.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
    var iKey = ikm ? ikm[1] : null;
    var iTitle = (ihtml.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
    var isErr = iTitle.indexOf('Error')>=0 || iTitle.indexOf('error')>=0;
    console.log('\ncategoryId='+cat+': key='+iKey+' title="'+iTitle+'"');

    if (!iKey) { console.log('  No key extracted, skipping'); continue; }

    // Try getReportsForView as GET with export params
    csrf = await getFreshCsrf(cookie, ua);
    hdrs[csrf.name] = csrf.value;
    var pdfUrl1 = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'
      +'&_flowExecutionKey='+encodeURIComponent(iKey)
      +'&_eventId=getReportsForView'
      +'&exportType=pdf&contentDisposition=attachment'
      +'&storeId='+storeId+'&date='+dateStr;
    var pr1 = await fetch(pdfUrl1, {headers:hdrs});
    var pct1 = pr1.headers.get('content-type')||'';
    var ptxt1 = await pr1.text();
    var pt1 = (ptxt1.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
    console.log('  getReportsForView GET: '+pr1.status+' ct='+pct1.substring(0,40)+' title="'+pt1+'"');
    if (pct1.indexOf('pdf')>=0||pct1.indexOf('octet')>=0) {
      fs.writeFileSync('/opt/render/project/src/uploads/hit.pdf',Buffer.from(ptxt1));
      console.log('  *** PDF SAVED ***'); return;
    }

    // Try getReportsForView as POST
    csrf = await getFreshCsrf(cookie, ua);
    var postHdrs = {Cookie:cookie,'User-Agent':ua,
      'Content-Type':'application/x-www-form-urlencoded',
      'X-Requested-With':'OWASP CSRFGuard Project',
      'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
    postHdrs[csrf.name] = csrf.value;
    var pbody = '_flowExecutionKey='+encodeURIComponent(iKey)
      +'&_eventId=getReportsForView'
      +'&exportType=pdf&contentDisposition=attachment'
      +'&storeId='+storeId+'&date='+dateStr+'&categoryId='+cat
      +'&'+csrf.name+'='+encodeURIComponent(csrf.value);
    var pr2 = await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow',
      {method:'POST',headers:postHdrs,body:pbody});
    var pct2 = pr2.headers.get('content-type')||'';
    var ptxt2 = await pr2.text();
    var pt2 = (ptxt2.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
    var pk2 = (ptxt2.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/))||[];
    pk2 = pk2[1]||null;
    console.log('  getReportsForView POST: '+pr2.status+' ct='+pct2.substring(0,40)+' title="'+pt2+'" newKey='+pk2);
    if (pct2.indexOf('pdf')>=0||pct2.indexOf('octet')>=0) {
      fs.writeFileSync('/opt/render/project/src/uploads/hit.pdf',Buffer.from(ptxt2));
      console.log('  *** PDF SAVED ***'); return;
    }

    // If POST advanced the key to a non-error state, try getReportsForView from there
    if (pk2 && pk2!==iKey && pt2.indexOf('Error')<0 && pt2.indexOf('Login')<0) {
      console.log('  Non-error new key '+pk2+' from POST, trying getReportsForView...');
      csrf = await getFreshCsrf(cookie, ua);
      hdrs[csrf.name] = csrf.value;
      var pdfUrl3 = ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'
        +'&_flowExecutionKey='+encodeURIComponent(pk2)
        +'&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment';
      var pr3 = await fetch(pdfUrl3, {headers:hdrs});
      var pct3 = pr3.headers.get('content-type')||'';
      var ptxt3 = await pr3.text();
      var pt3 = (ptxt3.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
      console.log('    -> '+pr3.status+' ct='+pct3.substring(0,40)+' title="'+pt3+'"');
      if (pct3.indexOf('pdf')>=0||pct3.indexOf('octet')>=0) {
        fs.writeFileSync('/opt/render/project/src/uploads/hit.pdf',Buffer.from(ptxt3));
        console.log('    *** PDF SAVED ***'); return;
      }
    }
  }

  // =====================================================================
  // D. aboveStore REST API -- try inStoreTime with storeId and date
  // =====================================================================
  console.log('\n--- D. aboveStore REST API variants ---');
  var restPaths = [
    '/asp/rest_v2/aboveStore/inStoreTime?storeId=29865&date=2026-04-18',
    '/asp/rest_v2/aboveStore/inStoreTime?storeId=29865&startDate=2026-04-18&endDate=2026-04-18',
    '/asp/rest_v2/aboveStore/report?storeId=29865&date=2026-04-18&categoryId=4',
    '/asp/rest_v2/aboveStore/report?storeId=29865&date=2026-04-18&categoryId=1',
    '/asp/rest_v2/aboveStore/export?storeId=29865&date=2026-04-18',
    '/asp/rest_v2/aboveStore/run?storeId=29865&date=2026-04-18',
    '/asp/rest_v2/aboveStore?storeId=29865&date=2026-04-18',
    '/asp/rest_v2/aboveStore/stores/29865',
    '/asp/rest_v2/aboveStore/stores/29865/inStoreTime?date=2026-04-18',
  ];
  for (var ri=0; ri<restPaths.length; ri++) {
    var rp = restPaths[ri];
    var rr = await fetch(ODS_URL+rp, {headers:{Cookie:cookie,'User-Agent':ua}});
    var rct = rr.headers.get('content-type')||'';
    var rt = await rr.text();
    console.log('  '+rp.replace('/asp/rest_v2/aboveStore','').padEnd(50)+' -> '+rr.status+' '+rct.substring(0,30)+' | '+rt.substring(0,100));
    if (rr.status===200 && (rct.indexOf('json')>=0 || rct.indexOf('pdf')>=0)) {
      console.log('    FULL: '+rt.substring(0,500));
    }
  }

  console.log('\nDone.');
}

main().catch(function(e){ console.error('FATAL:', e.message); process.exit(1); });
