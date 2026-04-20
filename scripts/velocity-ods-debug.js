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
  var r1 = await fetch(ODS_URL+'/asp/login.html', {headers:{'User-Agent':UA}});
  var c1 = parseCookies(r1);
  var r2 = await fetch(ODS_URL+'/asp/JavaScriptServlet', {method:'POST',
    headers:{'Cookie':mergeCookies(c1),'FETCH-CSRF-TOKEN':'1','X-Requested-With':'XMLHttpRequest','User-Agent':UA}});
  var c2=parseCookies(r2); var raw=await r2.text();
  var colon=raw.indexOf(':');
  var csrfName=raw.substring(0,colon).trim(); var csrfValue=raw.substring(colon+1).trim();
  var formBody=['orgId='+encodeURIComponent(ODS_ORG),'j_username='+encodeURIComponent(ODS_USER),
    'j_password='+encodeURIComponent(ODS_PASS),'j_password_pseudo='+encodeURIComponent(ODS_PASS),
    csrfName+'='+encodeURIComponent(csrfValue)].join('&');
  var r3=await fetch(ODS_URL+'/asp/j_spring_security_check', {method:'POST',redirect:'manual',
    headers:{'Content-Type':'application/x-www-form-urlencoded','Cookie':mergeCookies(c1,c2),
             'Referer':ODS_URL+'/asp/login.html','Origin':ODS_URL,'User-Agent':UA},body:formBody});
  var c3=parseCookies(r3); var loc=r3.headers.get('location')||'';
  if (loc.indexOf('error')>=0) throw new Error('Login failed: '+loc);
  console.log('[LOGIN] OK ->',loc);
  return {cookie:mergeCookies(c1,c2,c3),ua:UA};
}
async function fetchModule(cookie, ua, path) {
  var url = ODS_URL+'/asp/optimized-scripts/'+path+'.js';
  var r = await fetch(url, {headers:{Cookie:cookie,'User-Agent':ua}});
  console.log('\n[FETCH] '+url+' -> '+r.status+' ('+r.headers.get('content-type')+')');
  if (!r.ok) return null;
  var text = await r.text();
  console.log('  Size: '+text.length+' bytes');
  fs.writeFileSync('/tmp/ods-'+path.replace(/[\/\.]/g,'_')+'.js', text);
  return text;
}
async function main() {
  if (!ODS_PASS) { console.error('ODS_PASSWORD not set'); process.exit(1); }
  var sess = await login();
  var cookie=sess.cookie; var ua=sess.ua;

  // Fetch the actual aboveStore module bundles
  var modules = [
    'aboveStore/dist/aboveStore.main',
    'aboveStore/dist/aboveStore.decoration',
    'aboveStore/dist/aboveStore.orgType',
    'aboveStore/dist/aboveStore.stores',
  ];
  for (var i=0; i<modules.length; i++) {
    var text = await fetchModule(cookie, ua, modules[i]);
    if (text) {
      // Extract lines containing eventId, _eventId, flowExecution, getReport
      var hits = text.split('\n').filter(function(l) {
        return /_eventId|eventId|flowExec|getReport|inStoreTime|IST|export|pdf|getReports/i.test(l);
      });
      console.log('  Event/flow refs (first 20):');
      hits.slice(0,20).forEach(function(l){ console.log('    '+l.trim().substring(0,200)); });

      // Also look for string literals that might be event names
      var evStrings = [];
      var re = /['"](get[A-Za-z]+|inStore[A-Za-z]*|view[A-Za-z]+|select[A-Za-z]+|run[A-Za-z]+|load[A-Za-z]+|show[A-Za-z]+|init[A-Za-z]*|next[A-Za-z]*)['"]/g;
      var m;
      while ((m=re.exec(text)) !== null) evStrings.push(m[1]);
      var unique = evStrings.filter(function(v,i,a){return a.indexOf(v)===i;});
      console.log('  Candidate event strings: '+unique.join(', '));
    }
  }

  // Also try fetching without .js extension and with .min.js
  var altPaths = [
    'aboveStore/dist/aboveStore.main.min',
    'aboveStore/dist/main',
    'aboveStore/main',
  ];
  for (var j=0; j<altPaths.length; j++) {
    var ar = await fetch(ODS_URL+'/asp/optimized-scripts/'+altPaths[j]+'.js',
      {headers:{Cookie:cookie,'User-Agent':ua}});
    console.log('[TRY] '+altPaths[j]+'.js -> '+ar.status);
  }
}
main().catch(function(e){console.error('FATAL:',e.message);process.exit(1);});
