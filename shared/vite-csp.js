// Both web apps may be built from the repository root, where only the shared vercel.json is read. So each built page also carries
// its own Content-Security-Policy, taken from the app's vercel.json, and the policy holds whichever settings file the host uses.
import fs from 'node:fs';

/** `appDir` is the app's folder as a URL, e.g. new URL('./', import.meta.url) in its vite.config.js. */
export function pagePolicy(appDir) {
  let apiUrl = '';
  return {
    name: 'mezmitra-page-policy',
    apply: 'build', // the development server needs inline scripts for hot reload
    configResolved(config) {
      apiUrl = config.env?.VITE_API_URL ?? '';
    },
    transformIndexHtml() {
      const rules = JSON.parse(fs.readFileSync(new URL('vercel.json', appDir), 'utf8')).headers;
      const policy = rules.flatMap((rule) => rule.headers).find((header) => header.key === 'Content-Security-Policy').value;
      const apiOrigin = /^https?:\/\//.test(apiUrl) ? new URL(apiUrl).origin : '';
      const content = policy
        .split(';')
        .map((part) => part.trim().split(/\s+/))
        // Who may frame a page can only be said in a header; the shared vercel.json sends that one.
        .filter(([name]) => name && name !== 'frame-ancestors')
        // An API that moved is allowed wherever the listed one was.
        .map((part) => (apiOrigin && (part[0] === 'connect-src' || part[0] === 'img-src') && !part.includes(apiOrigin) ? [...part, apiOrigin] : part))
        .map((part) => part.join(' '))
        .join('; ');
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content }, injectTo: 'head-prepend' }];
    },
  };
}
