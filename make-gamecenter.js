// Writes the small Game Center plugin (plugins/motorbaron-gamecenter) that lets the game
// sign in to Game Center, report achievements and leaderboard scores, and open the Game Center screens.
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
        CAPPluginMethod(name: "submitScore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rank", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise)
    ]
    private var started = false
    private var finished = false
    private var waiting: [CAPPluginCall] = []

    // Achievements and leaderboards shared between apps through a Game Center group get a "grp." prefix.
    // The game always sends the plain ID; these maps turn it into whatever App Store Connect uses.
    private var achIds: [String: String] = [:]
    private var lbIds: [String: String] = [:]
    private var idsLoaded = false
    private var idsWaiting: [() -> Void] = []

    private static func base(_ id: String) -> String {
        return id.hasPrefix("grp.") ? String(id.dropFirst(4)) : id
    }

    private func withIds(_ done: @escaping () -> Void) {
        DispatchQueue.main.async {
            if self.idsLoaded { done(); return }
            self.idsWaiting.append(done)
            if self.idsWaiting.count > 1 { return }
            let group = DispatchGroup()
            group.enter()
            GKAchievementDescription.loadAchievementDescriptions { descs, _ in
                DispatchQueue.main.async {
                    for d in descs ?? [] { self.achIds[GameCenterPlugin.base(d.identifier)] = d.identifier }
                    group.leave()
                }
            }
            group.enter()
            GKLeaderboard.loadLeaderboards(IDs: nil) { boards, _ in
                DispatchQueue.main.async {
                    for b in boards ?? [] {
                        let id = b.baseLeaderboardID
                        self.lbIds[GameCenterPlugin.base(id)] = id
                    }
                    group.leave()
                }
            }
            group.notify(queue: .main) {
                self.idsLoaded = true
                let calls = self.idsWaiting
                self.idsWaiting = []
                for c in calls { c() }
            }
        }
    }

    private func achID(_ id: String) -> String {
        return achIds[GameCenterPlugin.base(id)] ?? id
    }

    private func lbID(_ id: String) -> String {
        return lbIds[GameCenterPlugin.base(id)] ?? id
    }

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
                    self.presentAuth(vc)
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

    // The bridge's view controller may not be on screen yet this early in launch;
    // presenting then is silently dropped by UIKit. Wait until it's actually visible.
    private func presentAuth(_ vc: UIViewController, retries: Int = 10) {
        DispatchQueue.main.async {
            guard let root = self.bridge?.viewController,
                  root.viewIfLoaded?.window != nil,
                  root.presentedViewController == nil else {
                if retries > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.presentAuth(vc, retries: retries - 1)
                    }
                }
                return
            }
            root.present(vc, animated: true, completion: nil)
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
        withIds {
            let list = ids.map { id -> GKAchievement in
                let a = GKAchievement(identifier: self.achID(id))
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
    }

    @objc func submitScore(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("Missing leaderboard id")
            return
        }
        let score = Int(call.getDouble("score") ?? 0)
        if !GKLocalPlayer.local.isAuthenticated || score <= 0 {
            call.resolve(["submitted": false])
            return
        }
        withIds {
            GKLeaderboard.submitScore(score, context: 0, player: GKLocalPlayer.local, leaderboardIDs: [self.lbID(id)]) { error in
                if let e = error {
                    call.reject(e.localizedDescription)
                } else {
                    call.resolve(["submitted": true])
                }
            }
        }
    }

    @objc func rank(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("Missing leaderboard id")
            return
        }
        if !GKLocalPlayer.local.isAuthenticated {
            call.resolve(["found": false])
            return
        }
        withIds {
            GKLeaderboard.loadLeaderboards(IDs: [self.lbID(id)]) { boards, _ in
                guard let board = boards?.first else {
                    call.resolve(["found": false])
                    return
                }
                board.loadEntries(for: .global, timeScope: .allTime, range: NSRange(location: 1, length: 1)) { local, _, total, _ in
                    if let me = local {
                        call.resolve(["found": true, "rank": me.rank, "total": total, "score": me.score])
                    } else {
                        call.resolve(["found": false, "total": total])
                    }
                }
            }
        }
    }

    @objc func show(_ call: CAPPluginCall) {
        let view = call.getString("view") ?? "achievements"
        DispatchQueue.main.async {
            if !GKLocalPlayer.local.isAuthenticated {
                call.resolve(["shown": false])
                return
            }
            let vc = GKGameCenterViewController(state: view == "leaderboards" ? .leaderboards : .achievements)
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
