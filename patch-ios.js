// Run after "npx cap add ios": iPhone-only, portrait-only, export-compliance flag, version numbers.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const build = process.argv[2] || '1';
const version = require(path.join(root, 'package.json')).version;
const plistP = path.join(root, 'ios/App/App/Info.plist');
let pl = fs.readFileSync(plistP, 'utf8');
pl = pl.replace(/<key>UISupportedInterfaceOrientations<\/key>\s*<array>[\s\S]*?<\/array>/,
  '<key>UISupportedInterfaceOrientations</key>\n\t<array>\n\t\t<string>UIInterfaceOrientationPortrait</string>\n\t</array>');
pl = pl.replace(/<key>UIRequiredDeviceCapabilities<\/key>\s*<array>[\s\S]*?<\/array>/,
  '<key>UIRequiredDeviceCapabilities</key>\n\t<array>\n\t\t<string>arm64</string>\n\t</array>');
if (!pl.includes('ITSAppUsesNonExemptEncryption'))
  pl = pl.replace(/<dict>/, '<dict>\n\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>\n\t<key>UIStatusBarStyle</key>\n\t<string>UIStatusBarStyleDarkContent</string>');
fs.writeFileSync(plistP, pl);
const pbxP = path.join(root, 'ios/App/App.xcodeproj/project.pbxproj');
let pbx = fs.readFileSync(pbxP, 'utf8');
pbx = pbx.replace(/TARGETED_DEVICE_FAMILY = "1,2";/g, 'TARGETED_DEVICE_FAMILY = 1;')
  .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
  .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);
// Game Center needs this entitlement in the signed app (full game only; the free edition has no Game Center).
const appId = require(path.join(root, 'capacitor.config.json')).appId;
const gc = !/\.free$/.test(appId);
if (gc) fs.writeFileSync(path.join(root, 'ios/App/App/App.entitlements'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.developer.game-center</key>
\t<true/>
</dict>
</plist>
`);
if (gc && !pbx.includes('CODE_SIGN_ENTITLEMENTS'))
  pbx = pbx.replace(/INFOPLIST_FILE = App\/Info.plist;/g, 'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n\t\t\t\tINFOPLIST_FILE = App/Info.plist;');
fs.writeFileSync(pbxP, pbx);
console.log('Patched iOS project for', appId + ': iPhone only, portrait,', gc ? 'Game Center on,' : 'no Game Center,', 'version', version, 'build', build);
