// Use Chromium's native browser features, including its PDF plugins. Do not
// replace navigator properties: frames and workers must agree with the page.
export const browserArgs = ['--disable-blink-features=AutomationControlled'];
export const ignoredBrowserArgs = ['--enable-automation'];

/** Keep the HTTP user agent and Chromium's client hints on the same version. */
export function chromeIdentity({ userAgent, product }, platform = process.platform, arch = process.arch) {
  if (!userAgent.includes('HeadlessChrome/')) return null;
  const version = /\/(\d+)([\d.]*)/.exec(product);
  if (!version) throw new Error('Could not read the Chromium version.');
  const major = version[1], full = major + version[2];
  const brands = [{ brand: 'Chromium', version: major }, { brand: 'Not A(Brand', version: '99' }];
  return {
    userAgent: userAgent.replace(/HeadlessChrome\/[\d.]+/, `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands, fullVersionList: brands.map(({ brand, version }) => ({ brand, version: version === major ? full : `${version}.0.0.0` })),
      platform: { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }[platform] || '',
      platformVersion: '', architecture: arch.startsWith('arm') ? 'arm' : 'x86', bitness: arch.includes('64') ? '64' : '32',
      model: '', mobile: false, wow64: false,
    },
  };
}

export async function browserIdentity(browser) {
  const cdp = await browser.newBrowserCDPSession();
  try { return chromeIdentity(await cdp.send('Browser.getVersion')); }
  finally { await cdp.detach(); }
}

export async function presentAsChrome(page, identity) {
  if (!identity) return;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Emulation.setUserAgentOverride', identity);
    // A new headless window can report 0×0 before Chromium creates it.
    // Let the native window exist before the site's first script runs.
    await page.evaluate(() => new Promise(done => {
      const ready = () => outerWidth > 0 && outerHeight > 0 ? done() : requestAnimationFrame(ready);
      ready();
    }));
  }
  catch (error) { await cdp.detach().catch(() => {}); throw error; }
  // Detaching resets emulation. Keep this session until its page closes;
  // it never enables Runtime or changes page objects.
  return cdp;
}
