package dev.hidemyemail.app.push

import com.google.firebase.messaging.FirebaseMessagingService

/**
 * Receives FCM token rotations and forwards them to [PushManager], which
 * re-registers the device with the Worker. Notification payloads (the
 * `notification` block the Worker sends) are rendered by the FCM SDK into the
 * system tray when the app is backgrounded, using the default channel declared
 * in the manifest — so there is no message-handling code to maintain here.
 */
class PushMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // May run in a cold process before the ViewModel wires PushManager, so
        // pass a context — the manager initialises from persisted state and
        // registers the rotated token itself.
        PushManager.onTokenRefresh(applicationContext, token)
    }
}
