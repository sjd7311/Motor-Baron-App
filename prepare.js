// Builds www/index.html and capacitor.config.json for one edition: "full" or "free".
const fs = require('fs'), path = require('path');
const edition = process.argv[2] === 'free' ? 'free' : 'full';
const E = {
  full: { appId: 'com.spencerdeville.motorbaron', appName: 'Motor Baron' },
  free: { appId: 'com.spencerdeville.motorbaron.free', appName: 'Motor Baron: 1900' }
}[edition];
const root = path.join(__dirname, '..');
let game = fs.readFileSync(path.join(root, 'src', 'game.html'), 'utf8');
game = game.replace(/<title>.*?<\/title>\n?/, '').replace(/<link rel="(preconnect|stylesheet)"[^>]*fonts\.g[^>]*>\n?/g, '');
const faces = [['Big Shoulders Display','big-shoulders-display',[600,800]],['IBM Plex Mono','ibm-plex-mono',[400,500]],['IBM Plex Sans','ibm-plex-sans',[400,500,600]]]
  .flatMap(([fam, f, ws]) => ws.map(w => `@font-face{font-family:'${fam}';font-style:normal;font-weight:${w};font-display:swap;src:url(fonts/${f}-latin-${w}-normal.woff2) format('woff2')}`)).join('\n');
game = game.replace('<style>', '<style>\n' + faces);
const cut = game.indexOf('</style>') + '</style>'.length;
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#1d5842">
<title>${E.appName}</title>
<script>window.CARCO_EDITION=${JSON.stringify(edition)};window.CARCO_NATIVE=true;</script>
${game.slice(0, cut)}
</head>
<body>
${game.slice(cut)}
</body>
</html>
`;
fs.mkdirSync(path.join(root, 'www'), { recursive: true });
fs.writeFileSync(path.join(root, 'www', 'index.html'), html);
fs.mkdirSync(path.join(root, 'www', 'fonts'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'fonts'))) fs.copyFileSync(path.join(root, 'fonts', f), path.join(root, 'www', 'fonts', f));
fs.writeFileSync(path.join(root, 'capacitor.config.json'), JSON.stringify({
  appId: E.appId, appName: E.appName, webDir: 'www',
  ios: { contentInset: 'never', backgroundColor: '#e9ece6', scrollEnabled: true },
  plugins: { SplashScreen: { launchShowDuration: 1800, launchAutoHide: true, launchFadeOutDuration: 400, backgroundColor: '#1d5842', showSpinner: false, iosSpinnerStyle: 'small' } }
}, null, 2));
fs.writeFileSync(path.join(root, 'edition.env'), `APP_NAME="${E.appName}"\nBUNDLE_ID=${E.appId}\n`);
console.log('Prepared', edition, E.appId, (html.length / 1024).toFixed(0) + ' KB');
