// =====================================================================
// VELOCITY EMAIL — Daily SOS report emails via Gmail (nodemailer)
// =====================================================================
'use strict';

const { istColor } = require('./velocity-compute');

function createTransporter() {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.VELOCITY_EMAIL_USER || 'velocityai.reports@gmail.com',
      pass: process.env.VELOCITY_EMAIL_PASS
    }
  });
}

function generateEmailHTML(stores, targetDate, areaFilter = null) {
  const filtered = areaFilter ? stores.filter(s => s.area_coach === areaFilter || s.area === areaFilter) : stores;
  const valid = filtered.filter(s => s.wtd_ist != null);

  const avgIST = valid.length ? (valid.reduce((a, s) => a + s.wtd_ist, 0) / valid.length).toFixed(1) : '—';
  const avgLt19 = valid.length ? (valid.reduce((a, s) => a + (s.wtd_lt19_pct || 0), 0) / valid.length).toFixed(1) : '—';
  const totalOrders = valid.reduce((a, s) => a + (s.wtd_orders || 0), 0);

  const sorted = [...valid].sort((a, b) => (a.wtd_ist || 99) - (b.wtd_ist || 99));
  const top5 = sorted.slice(0, 5);
  const bottom5 = sorted.slice(-5).reverse();

  const storeRow = (s) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #ddd"><strong>${s.name}</strong><br><small style="color:#666">${s.store_id} · ${s.area_coach}</small></td>
      <td style="padding:8px;border-bottom:1px solid #ddd;color:${istColor(s.wtd_ist)};font-weight:bold">${s.wtd_ist != null ? s.wtd_ist + ' min' : '—'}</td>
      <td style="padding:8px;border-bottom:1px solid #ddd">${s.wtd_lt19_pct != null ? s.wtd_lt19_pct + '%' : '—'}</td>
      <td style="padding:8px;border-bottom:1px solid #ddd">${s.wtd_orders || '—'}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;background:#fff}
  h1{color:#e31837;border-bottom:3px solid #e31837;padding-bottom:10px}
  h2{color:#333;margin-top:25px}
  .scorecard{display:flex;gap:15px;flex-wrap:wrap;margin:15px 0}
  .card{background:#f5f5f5;border-radius:8px;padding:15px;min-width:140px;text-align:center}
  .card .val{font-size:24px;font-weight:bold;color:#333}
  .card .lbl{font-size:12px;color:#666;margin-top:4px}
  table{width:100%;border-collapse:collapse;margin:10px 0}
  th{background:#333;color:#fff;padding:10px;text-align:left}
  .footer{margin-top:30px;padding-top:15px;border-top:1px solid #ddd;color:#999;font-size:11px}
</style></head>
<body>
<h1>🍕 Velocity — Daily Speed of Service</h1>
<p><strong>Report Date:</strong> ${targetDate}${areaFilter ? ` &nbsp;·&nbsp; <strong>Area:</strong> ${areaFilter}` : ''}</p>

<div class="scorecard">
  <div class="card"><div class="val" style="color:${istColor(parseFloat(avgIST))}">${avgIST}</div><div class="lbl">Avg IST (min)</div></div>
  <div class="card"><div class="val">${avgLt19}%</div><div class="lbl">% Under 19 min</div></div>
  <div class="card"><div class="val">${valid.length}</div><div class="lbl">Stores Reporting</div></div>
  <div class="card"><div class="val">${totalOrders.toLocaleString()}</div><div class="lbl">Total Deliveries</div></div>
</div>

<h2>🏆 Top 5 Performers</h2>
<table><tr><th>Store</th><th>Avg IST</th><th>% &lt;19 min</th><th>Deliveries</th></tr>
${top5.map(storeRow).join('')}
</table>

<h2>⚠️ Bottom 5 Performers</h2>
<table><tr><th>Store</th><th>Avg IST</th><th>% &lt;19 min</th><th>Deliveries</th></tr>
${bottom5.map(storeRow).join('')}
</table>

<div class="footer">
  Velocity — Ayvaz Pizza Speed of Service Dashboard &nbsp;·&nbsp; Generated ${new Date().toLocaleString('en-US',{timeZone:'America/Chicago'})} CT
</div>
</body></html>`;
}

async function sendDailyEmails(wtdStores, targetDate, excelBuffer) {
  const transporter = createTransporter();
  const results = { sent: [], failed: [] };

  const attachment = excelBuffer ? [{
    filename: `Velocity_IST_${targetDate}.xlsx`,
    content: excelBuffer,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }] : [];

  const FROM = `"Velocity Reports" <${process.env.VELOCITY_EMAIL_USER || 'velocityai.reports@gmail.com'}>`;

  // Harold gets the full company view
  await trySend(transporter, {
    from: FROM, to: 'hlacoste@ayvazpizza.com',
    subject: `Velocity Daily Report — ${targetDate}`,
    html: generateEmailHTML(wtdStores, targetDate),
    attachments: attachment
  }, results);

  // Preston Arnwine — full company view (peer)
  await trySend(transporter, {
    from: FROM, to: 'parnwine@ayvazpizza.com',
    subject: `Velocity Daily Report — ${targetDate}`,
    html: generateEmailHTML(wtdStores, targetDate),
    attachments: attachment
  }, results);

  // Terrance Spillane — full company view (peer)
  await trySend(transporter, {
    from: FROM, to: 'tspillane@ayvazpizza.com',
    subject: `Velocity Daily Report — ${targetDate}`,
    html: generateEmailHTML(wtdStores, targetDate),
    attachments: attachment
  }, results);

  // Matt Hester (VP) — full company view
  await trySend(transporter, {
    from: FROM, to: 'mhester@ayvazpizza.com',
    subject: `Velocity Daily Report — ${targetDate}`,
    html: generateEmailHTML(wtdStores, targetDate),
    attachments: attachment
  }, results);

  // Area coaches — filtered to their area
  const areaCoachEmails = {
    'Jorge Garcia':     'jgarcia@ayvazpizza.com',
    'Darian Spikes':    'dspikes@ayvazpizza.com',
    'Marc Gannon':      'mgannon@ayvazpizza.com',
    'Ebony Simmons':    'esimmons@ayvazpizza.com',
    "Ja'Don McNeil":    'jmcneil@ayvazpizza.com',
    'Michelle Meehan':  'mmeehan@ayvazpizza.com',
    'Emmanuel Boateng': 'eboateng@ayvazpizza.com',
    'Erin Pizzo':       'epizzo@ayvazpizza.com',
    'Royal Mitchell':   'rmitchell@ayvazpizza.com',
    'Russell Kowalczyk':'rkowalczyk@ayvazpizza.com',
    'Brenda Marta':     'bmarta@ayvazpizza.com',
    'Constance Miranda':'cmiranda@ayvazpizza.com',
    'Eric Harstine':    'eharstine@ayvazpizza.com',
    'Javier Martinez':  'jmartinez@ayvazpizza.com',
    'Kevin Dunn':       'kdunn@ayvazpizza.com',
    'Max Losey':        'mlosey@ayvazpizza.com',
    'Oscar Gutierrez':  'ogutierrez@ayvazpizza.com',
    'Tami Elliott-Baker':'telliottbaker@ayvazpizza.com'
  };

  for (const [coach, email] of Object.entries(areaCoachEmails)) {
    await trySend(transporter, {
      from: FROM, to: email,
      subject: `Velocity Daily Report — ${targetDate}`,
      html: generateEmailHTML(wtdStores, targetDate, coach),
      attachments: attachment
    }, results);
  }

  return results;
}

async function trySend(transporter, options, results) {
  try {
    const info = await transporter.sendMail(options);
    results.sent.push({ to: options.to, messageId: info.messageId });
  } catch (e) {
    console.error(`[Email] Failed to ${options.to}:`, e.message);
    results.failed.push({ to: options.to, error: e.message });
  }
}

module.exports = { sendDailyEmails, generateEmailHTML };
