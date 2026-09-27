// Writes the small Game Center plugin (plugins/motorbaron-gamecenter) that lets the game
// sign in to Game Center, report achievements and open the achievements screen.
// Kept as one script so the repo can hold it as a single file.
const fs = require('fs'), path = require('path');
const root = fs.existsSync(path.join(__dirname, 'package.json')) ? __dirname : path.join(__dirname, '..');
const dir = path.join(root, 'plugins', 'motorbaron-gamecenter');
const src = path.join(dir, 'ios', 'Sources', 'GameCenterPlugin');
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
  name: 'motorbaron-gamecenter', version: '1.0.0', private: true,
  description: 'Game Center for Motor Baron', capacitor: { ios: { src: 'ios' } }
}, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'Package.swift'), `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MotorbaronGamecenter",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "MotorbaronGamecenter", targets: ["GameCenterPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "GameCenterPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/GameCenterPlugin",
            linkerSettings: [.linkedFramework("GameKit")])
    ]
)
`);
fs.writeFileSync(path.join(src, 'GameCenterPlugin.swift'), `import Foundation
import Capacitor
import GameKit

@objc(GameCenterPlugin)
public class GameCenterPlugin: CAPPlugin, CAPBridgedPlugin, GKGameCenterControllerDelegate {
    public let identifier = "GameCenterPlugin"
    public let jsName = "MotorBaronGameCenter"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlockMany", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise)
    ]
    private var started = false
    private var finished = false
    private var waiting: [CAPPluginCall] = []

    @objc func signIn(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if GKLocalPlayer.local.isAuthenticated || self.finished {
                call.resolve(["signedIn": GKLocalPlayer.local.isAuthenticated])
                return
            }
            self.waiting.append(call)
            if self.started { return }
            self.started = true
            GKLocalPlayer.local.authenticateHandler = { [weak self] viewController, error in
                guard let self = self else { return }
                if let vc = viewController {
                    self.bridge?.viewController?.present(vc, animated: true, completion: nil)
                    return
                }
                self.finished = true
                let ok = GKLocalPlayer.local.isAuthenticated
                let calls = self.waiting
                self.waiting = []
                for c in calls {
                    c.resolve(["signedIn": ok, "error": error?.localizedDescription ?? ""])
                }
            }
        }
    }

    @objc func unlock(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("Missing achievement id")
            return
        }
        report([id], banner: call.getBool("banner") ?? true, call: call)
    }

    @objc func unlockMany(_ call: CAPPluginCall) {
        let ids = (call.getArray("ids") ?? []).compactMap { $0 as? String }
        report(ids, banner: false, call: call)
    }

    private func report(_ ids: [String], banner: Bool, call: CAPPluginCall) {
        if ids.isEmpty || !GKLocalPlayer.local.isAuthenticated {
            call.resolve(["reported": false])
            return
        }
        let list = ids.map { id -> GKAchievement in
            let a = GKAchievement(identifier: id)
            a.percentComplete = 100
            a.showsCompletionBanner = banner
            return a
        }
        GKAchievement.report(list) { error in
            if let e = error {
                call.reject(e.localizedDescription)
            } else {
                call.resolve(["reported": true])
            }
        }
    }

    @objc func show(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if !GKLocalPlayer.local.isAuthenticated {
                call.resolve(["shown": false])
                return
            }
            let vc = GKGameCenterViewController(state: .achievements)
            vc.gameCenterDelegate = self
            self.bridge?.viewController?.present(vc, animated: true, completion: nil)
            call.resolve(["shown": true])
        }
    }

    public func gameCenterViewControllerDidFinish(_ gameCenterViewController: GKGameCenterViewController) {
        gameCenterViewController.dismiss(animated: true, completion: nil)
    }
}
`);
console.log('Wrote Game Center plugin to', path.relative(root, dir));
