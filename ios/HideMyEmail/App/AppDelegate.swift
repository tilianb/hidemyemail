import UIKit
import UserNotifications

/// Minimal UIKit app delegate, bridged into the SwiftUI lifecycle via
/// `@UIApplicationDelegateAdaptor`. Its only job is to forward APNs device-token
/// callbacks to `PushManager` and to let notifications present while the app is
/// foregrounded.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        // Delegate callbacks run on the main thread; hop onto the MainActor.
        MainActor.assumeIsolated {
            PushManager.shared.didRegister(tokenData: deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        MainActor.assumeIsolated {
            PushManager.shared.didFail(error: error)
        }
    }

    // Show banners/sounds even when the app is in the foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }
}
