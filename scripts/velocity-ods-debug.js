'use strict';
var fs = require('fs');
var ODS_URL  = 'https://bi.onedatasource.com';
var ODS_ORG  = process.env.ODS_ORG  || 'dgi';
var ODS_USER = process.env.ODS_USER || 'hlacoste';
var ODS_PASS = process.env.ODS_PASSWORD || '';
function fetch() { return require('node-fetch').apply(null, arguments); }
function parseCookies(r) {
  return (r.headers.raw()['set-cookie'] || []).map(function(c) { return c.split(';')[0]; });
}
function mergeCookies(a, b, c) {
  var map = new Map();
  [].concat(a||[],b||[],c||[]).forEach(function(ck){ var n=ck.split('=')[0]; map.set(n,ck); });
  return Array.from(map.values()).join('; ');
}
async function login() {
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  var r1 = await fetch(ODS_URL+'/asp/login.html',{headers:{'User-Agent':UA}});
  var c1 = parseCookies(r1);
  var r2 = await fetch(ODS_URL+'/asp/JavaScriptServlet',{method:'POST',
    headers:{'Cookie':mergeCookies(c1),'FETCH-CSRF-TOKEN':'1','X-Requested-With':'XMLHttpRequest','User-Agent':UA}});
  var c2=parseCookies(r2); var raw=await r2.text();
  var colon=raw.indexOf(':');
  var csrfName=raw.substring(0,colon).trim(); var csrfValue=raw.substring(colon+1).trim();
  var formBody=['orgId='+encodeURIComponent(ODS_ORG),'j_username='+encodeURIComponent(ODS_USER),
    'j_password='+encodeURIComponent(ODS_PASS),'j_password_pseudo='+encodeURIComponent(ODS_PASS),
    csrfName+'='+encodeURIComponent(csrfValue)].join('&');
  var r3=await fetch(ODS_URL+'/asp/j_spring_security_check',{method:'POST',redirect:'manual',
    headers:{'Content-Type':'application/x-www-form-urlencoded','Cookie':mergeCookies(c1,c2),
             'Referer':ODS_URL+'/asp/login.html','Origin':ODS_URL,'User-Agent':UA},body:formBody});
  var c3=parseCookies(r3); var loc=r3.headers.get('location')||'';
  if(loc.indexOf('error')>=0) throw new Error('Login failed: '+loc);
  console.log('[LOGIN] OK ->',loc);
  return {cookie:mergeCookies(c1,c2,c3),ua:UA};
}
async function getFreshCsrf(cookie,ua) {
  var r=await fetch(ODS_URL+'/asp/JavaScriptServlet',{method:'POST',
    headers:{'Cookie':cookie,'FETCH-CSRF-TOKEN':'1','User-Agent':ua}});
  var text=await r.text(); var colon=text.indexOf(':');
  var name=text.substring(0,colon).trim(); var value=text.substring(colon+1).trim();
  console.log('[CSRF] Fresh: '+name+'='+value.substring(0,12)+'...');
  return {name:name,value:value};
}
async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess=await login(); var cookie=sess.cookie; var ua=sess.ua;

  // A. require.config.js
  console.log('\n--- A. require.config.js ---');
  var rcRes=await fetch(ODS_URL+'/asp/optimized-scripts/require.config.js',{headers:{Cookie:cookie,'User-Agent':ua}});
  var rcText=await rcRes.text();
  console.log('Status:',rcRes.status,' Bytes:',rcText.length);
  if(rcRes.ok){
    fs.writeFileSync('/tmp/ods-require-config.js',rcText);
    var abLines=rcText.split('\n').filter(function(l){return /aboveStore/i.test(l);});
    console.log('aboveStore entries:\n  '+abLines.join('\n  '));
    console.log('\nFirst 80 lines:');
    console.log(rcText.split('\n').slice(0,80).join('\n'));
  }

  // B. s1 HTML key sections
  console.log('\n--- B. s1 HTML sections ---');
  var s1Path='/tmp/ods-s1.html';
  if(!fs.existsSync(s1Path)){
    var r0=await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow',{headers:{Cookie:cookie,'User-Agent':ua}});
    fs.writeFileSync(s1Path,await r0.text());
  }
  var lines=fs.readFileSync(s1Path,'utf8').split('\n');
  console.log('\n== Lines 230-295 ==');
  console.log(lines.slice(229,295).join('\n'));
  console.log('\n== Lines 435-600 (decoration callback) ==');
  console.log(lines.slice(434,600).join('\n'));

  // C. Fresh CSRF + s1 key
  console.log('\n--- C. Fresh CSRF + s1 key ---');
  var csrf=await getFreshCsrf(cookie,ua);
  var fRes=await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow',{headers:{Cookie:cookie,'User-Agent':ua}});
  var fHtml=await fRes.text();
  var km=fHtml.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/);
  var s1Key=km?km[1]:null;
  console.log('s1 key:',s1Key);
  if(!s1Key){console.error('No s1 key'); process.exit(1);}

  // D. GET events with OWASP CSRFGuard headers
  console.log('\n--- D. GET events with OWASP CSRFGuard headers ---');
  var getEvents=['getReportsForView','inStoreTime','InStoreTime','view','run','next','start',
    'init','initialize','loadReports','showReports','selectReport','viewReport','display','show','load'];
  var csrfHdrs={Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  csrfHdrs[csrf.name]=csrf.value;
  for(var i=0;i<getEvents.length;i++){
    var ev=getEvents[i];
    var extra=(ev==='getReportsForView')?'&exportType=pdf&contentDisposition=attachment':'';
    var url=ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+encodeURIComponent(s1Key)+'&_eventId='+ev+extra;
    var r=await fetch(url,{headers:csrfHdrs});
    var ct=r.headers.get('content-type')||'';
    var body=await r.text();
    var newKey=(body.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/)||[])[1];
    var title=(body.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
    var isLogin=body.indexOf('oneVIEW: Login')>=0;
    var isErr=title.indexOf('Error')>=0;
    var mark=ct.indexOf('pdf')>=0?'*** PDF ***':isLogin?'LOGIN-PAGE':isErr?'error-page':'title="'+title+'" newKey='+newKey;
    console.log('  GET '+ev+' -> '+r.status+' '+mark);
    if(ct.indexOf('pdf')>=0||ct.indexOf('octet')>=0){
      fs.writeFileSync('/tmp/ods-hit.pdf',Buffer.from(body));
      console.log('  *** SAVED /tmp/ods-hit.pdf ***'); return;
    }
    if(newKey&&newKey!==s1Key&&!isErr&&!isLogin){
      console.log('    !! New key '+newKey+' -- trying getReportsForView');
      var csrf3=await getFreshCsrf(cookie,ua);
      var h3={Cookie:cookie,'User-Agent':ua,'X-Requested-With':'OWASP CSRFGuard Project',
        'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
      h3[csrf3.name]=csrf3.value;
      var pu=ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow&_flowExecutionKey='+encodeURIComponent(newKey)+'&_eventId=getReportsForView&exportType=pdf&contentDisposition=attachment';
      var pr=await fetch(pu,{headers:h3}); var pct=pr.headers.get('content-type')||'';
      console.log('    -> '+pr.status+' ct='+pct);
      if(pct.indexOf('pdf')>=0||pct.indexOf('octet')>=0){
        var buf=await pr.buffer(); fs.writeFileSync('/tmp/ods-hit.pdf',buf);
        console.log('    *** SAVED /tmp/ods-hit.pdf ***'); return;
      }
    }
  }

  // D2. POST events
  console.log('\n--- D2. POST events ---');
  var csrf4=await getFreshCsrf(cookie,ua);
  var postHdrs={Cookie:cookie,'User-Agent':ua,'Content-Type':'application/x-www-form-urlencoded',
    'X-Requested-With':'OWASP CSRFGuard Project',
    'Referer':ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow'};
  postHdrs[csrf4.name]=csrf4.value;
  var postEvents=['getReportsForView','inStoreTime','view','run','next','start','init'];
  for(var j=0;j<postEvents.length;j++){
    var pev=postEvents[j];
    var pb='_flowExecutionKey='+encodeURIComponent(s1Key)+'&_eventId='+pev+'&exportType=pdf&contentDisposition=attachment&'+csrf4.name+'='+encodeURIComponent(csrf4.value);
    var pr2=await fetch(ODS_URL+'/asp/flow.html?_flowId=aboveStoreInStoreReportsFlow',{method:'POST',headers:postHdrs,body:pb});
    var pct2=pr2.headers.get('content-type')||''; var ptxt=await pr2.text();
    var pk=(ptxt.match(/__jrsConfigs__\.flowExecutionKey\s*=\s*["']([^"']+)["']/)||[])[1];
    var pt=(ptxt.match(/<title>([^<]+)<\/title>/)||['','?'])[1];
    var pmk=pct2.indexOf('pdf')>=0?'*** PDF ***':ptxt.indexOf('oneVIEW: Login')>=0?'LOGIN-PAGE':pt.indexOf('Error')>=0?'error-page':'title="'+pt+'" newKey='+pk;
    console.log('  POST '+pev+' -> '+pr2.status+' '+pmk);
    if(pct2.indexOf('pdf')>=0||pct2.indexOf('octet')>=0){
      fs.writeFileSync('/tmp/ods-hit.pdf',Buffer.from(ptxt));
      console.log('  *** SAVED /tmp/ods-hit.pdf ***'); return;
    }
  }
  console.log('\n--- DONE. Key files: /tmp/ods-s1.html /tmp/ods-require-config.js ---');
}
main().catch(function(e){console.error('FATAL:',e.message);process.exit(1);});
