// Posts one macOS notification as "Elena", with Elena's icon.
//
// Built into ~/.elena/Elena.app by Elena (see src/notifier.ts). macOS shows a notification with the
// icon of the app that sent it, which is why this lives in its own tiny app bundle instead of using
// osascript (whose notifications carry Script Editor's icon).
//
// Launch it through Launch Services (`open -W -g -n Elena.app --args …`): macOS only lets a real app
// launch ask for and use notification permission, and running the binary directly is refused.
//
// Usage: open -W -g -n Elena.app --args <title> <body> [--sound] [--status <file>]
// Status (exit code, and written to --status because `open` doesn't pass exit codes back):
// 0 posted, 2 bad usage, 3 notifications not allowed, 4 couldn't post.
import Foundation
import UserNotifications

let args = CommandLine.arguments
let statusFile = args.firstIndex(of: "--status").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }

func finish(_ code: Int32) -> Never {
  if let file = statusFile { try? String(code).write(toFile: file, atomically: true, encoding: .utf8) }
  exit(code)
}

guard args.count >= 3 else {
  FileHandle.standardError.write("usage: elena-notify <title> <body> [--sound] [--status <file>]\n".data(using: .utf8)!)
  finish(2)
}

let center = UNUserNotificationCenter.current()
let done = DispatchSemaphore(value: 0)
var status: Int32 = 0

// The first time, macOS asks the user whether Elena may send notifications.
center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
  guard granted else {
    status = 3
    done.signal()
    return
  }
  let content = UNMutableNotificationContent()
  content.title = args[1]
  content.body = args[2]
  if args.contains("--sound") { content.sound = .default }
  let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
  center.add(request) { error in
    if error != nil { status = 4 }
    done.signal()
  }
}

// Waiting on the permission prompt can take a while; don't hang forever.
if done.wait(timeout: .now() + 120) == .timedOut { status = 3 }
finish(status)
