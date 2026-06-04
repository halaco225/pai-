'use strict';
// reporting-login-playwright-snippet.js
// Robust Playwright pattern for legacy reporting.smg.com ASP.NET login.

const REPORTING_ORIGIN = 'https://reporting.smg.com';
const LOGIN_URL = 'https://reporting.smg.com/MultiLanguage.aspx';

async function getAspxAuthCookie(context) {
  const cookies = await context.cookies(REPORTING_ORIGIN);
  return cookies.find(c => c.name === '.ASPXAUTH') || null;
}

async function waitForAspxAuthCookie(context, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cookie = await getAspxAuthCookie(context);
    if (cookie && cookie.value) return cookie;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}

async function loginToReporting(page, context, username, password, options = {}) {
  const timeoutMs = options.timeoutMs || 45000;

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  const formDebug = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, select, button')).map(el => ({
      tag: el.tagName, type: el.getAttribute('type'), name: el.getAttribute('name'),
      id: el.getAttribute('id'), visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    }))
  );
  console.log('Reporting login form controls: ' + JSON.stringify(formDebug.filter(e => e.visible)));

  const usernameSelector = [
    'input[name*="User" i]', 'input[id*="User" i]', 'input[name*="Login" i]',
    'input[id*="Login" i]',  'input[type="text"]',   'input:not([type])',
  ].join(', ');

  const passwordSelector = [
    'input[type="password"]', 'input[name*="Password" i]', 'input[id*="Password" i]',
  ].join(', ');

  const userInput = page.locator(usernameSelector).first();
  const passInput = page.locator(passwordSelector).first();

  await userInput.waitFor({ state: 'visible', timeout: timeoutMs });
  await passInput.waitFor({ state: 'visible', timeout: timeoutMs });

  // Use click + keyboard typing to trigger legacy JS events
  await userInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await userInput.type(username, { delay: 25 });
  await userInput.evaluate(el => {
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  });

  await passInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await passInput.type(password, { delay: 25 });
  await passInput.evaluate(el => {
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
  });

  page.on('response', async response => {
    const url = response.url();
    if (url.includes('reporting.smg.com')) console.log('Reporting response: ' + response.status() + ' ' + url);
  });

  const submitCandidates = [
    'input[type="submit"]', 'button[type="submit"]', 'input[id*="Submit" i]',
    'input[name*="Submit" i]', 'input[id*="Login" i][type="submit"]', 'button[id*="Login" i]',
  ].join(', ');

  const submit = page.locator(submitCandidates).first();
  const authWait = waitForAspxAuthCookie(context, timeoutMs);

  if (await submit.count()) {
    await submit.click();
  } else {
    await passInput.press('Enter');
  }

  // The login redirects to MultiLanguage.aspx for language selection BEFORE .ASPXAUTH is set.
  // Wait briefly to detect the language selection page.
  await page.waitForTimeout(2000);
  const currentUrl = page.url();

  if (currentUrl.includes('MultiLanguage')) {
    console.log('On language selection page — selecting English...');
    // Find English option (radio button, checkbox, or link) and click it
    const selected = await page.evaluate(() => {
      // Try radio buttons with value matching English
      const radios = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
      const englishRadio = radios.find(r => /^en(-us)?$/i.test(r.value) || /^english$/i.test(r.value) || r.value === 'en');
      if (englishRadio) { englishRadio.click(); return 'radio:' + englishRadio.value; }

      // Try links with text "English"
      const links = Array.from(document.querySelectorAll('a'));
      const englishLink = links.find(a => /^english$/i.test(a.textContent.trim()));
      if (englishLink) { englishLink.click(); return 'link:' + englishLink.href; }

      // Try selecting a language dropdown
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        const opt = Array.from(sel.options).find(o => /en/i.test(o.value) || /english/i.test(o.text));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return 'select:' + opt.value; }
      }
      // Log available options for diagnosis
      return 'not found — radios:' + radios.map(r => r.value).join(',') + ' links:' + links.slice(0,10).map(a=>a.textContent.trim()).join(',');
    });
    console.log('Language selection result: ' + selected);

    // Submit the language form
    const langSubmit = page.locator('input[type="submit"], button[type="submit"]').first();
    if (await langSubmit.count()) {
      await langSubmit.click();
    } else {
      await page.evaluate(() => document.querySelector('form').submit());
    }
    await page.waitForTimeout(2000);
    console.log('After language selection: ' + page.url().slice(0, 80));
  }

  // Now wait for .ASPXAUTH cookie
  const authCookie = await authWait;
  if (!authCookie) {
    const finalUrl = page.url();
    const bodyText = await page.locator('body').innerText().catch(() => '');
    throw new Error('Reporting login did not produce .ASPXAUTH cookie. URL: ' + finalUrl + ' body: ' + bodyText.slice(0, 500));
  }

  console.log('Reporting login succeeded — .ASPXAUTH cookie acquired.');
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(1000);
  return authCookie;
}

module.exports = { loginToReporting, getAspxAuthCookie, waitForAspxAuthCookie };
